/**
 * 明月秋青脚本 - 智脑系统入口
 *
 * 功能：
 * 1. 用户人格分析与注入
 * 2. 动态人设生成与注入
 * 3. 正文捕获与记录
 * 4. 精准大总结（精神链记忆库）
 * 5. 记忆激活系统
 * 6. 梦呓系统
 */
import { createScriptIdDiv, reloadOnChatChange, teleportStyle } from '@util/script';
import App from './App.vue';
import { buildDreamtalkInjection, executeDreamtalkAnalysis, scanCharacterNamesFromContent } from './core/dreamtalk';
import { injectDynamicProfiles } from './core/dynamicProfile';
import { injectNeuralChain } from './core/neuralChain';
import { injectPersonaIntoCompletion } from './core/persona';
import { injectNsfwData, isNsfwActive } from './core/nsfwIsolation';
import { executePlotFateAnalysis, injectPlotFate } from './core/plotFate';
import {
  executeEmotionAnalysis,
  injectEmotionState,
  shouldTriggerEmotionAnalysis,
  buildEmotionSummaryForPlotFate,
  type EmotionAccumulationState,
} from './core/emotionAccumulation';
import {
  executeGrandSummary,
  buildMemorySectionText,
  getContentsSinceLast,
  PRESERVE_RECENT_COUNT,
  shouldTriggerSummary,
} from './core/summary';
import {
  ensureRecentFloorsVisible as ensureRecentFloorsVisibleCore,
  getCapturedContentMessageIds,
  hideCapturedContentsWithUsers,
} from './core/floorVisibility';
import { extractContentFromMessage } from './utils/messageParser';
import { useMainStore, type GrandSummary } from './stores/mainStore';

$(() => {
  const pinia = createPinia();
  const app = createApp(App).use(pinia);

  // ========== 前端面板挂载（div模式，挂载到酒馆网页body） ==========

  const $app = createScriptIdDiv().appendTo('body');
  const { destroy } = teleportStyle();
  app.mount($app[0]);

  // ========== 正文捕获系统 ==========

  // 监听AI回复完成 → 捕获正文 + 记录用户输入 + 检查是否触发大总结
  eventOn(tavern_events.MESSAGE_RECEIVED, (messageId, type) => {
    const store = useMainStore(pinia);
    if (!store.settings.captureEnabled) return;

    // 只跳过明确不需要捕获的类型
    if (type === 'quiet' || type === 'command' || type === 'extension') return;

    const aiMessages = getChatMessages(messageId, { role: 'assistant' });
    if (aiMessages.length === 0) return;

    const aiMsg = aiMessages[0];
    const content = extractContentFromMessage(aiMsg.message);
    if (content) {
      store.captureContent(messageId, content);
      console.info(`[智脑] 捕获楼层 #${messageId} 正文 (${content.length} 字)`);

      // 记录用户输入
      const userMessages = getChatMessages(messageId - 1, { role: 'user' });
      if (userMessages.length > 0) {
        store.recordUserInput(messageId - 1, userMessages[0].message, content);
      }

      // 检查是否应该触发大总结
      checkAndTriggerSummary(store);
    }
  });

  // 监听消息被swipe → 更新正文记录
  eventOn(tavern_events.MESSAGE_SWIPED, messageId => {
    const store = useMainStore(pinia);
    if (!store.settings.captureEnabled) return;

    setTimeout(() => {
      const aiMessages = getChatMessages(messageId, { role: 'assistant' });
      if (aiMessages.length === 0) return;

      const aiMsg = aiMessages[0];
      const content = extractContentFromMessage(aiMsg.message);
      if (content) {
        store.captureContent(messageId, content);
        console.info(`[智脑] 更新楼层 #${messageId} 正文 (swipe)`);

        const userMessages = getChatMessages(messageId - 1, { role: 'user' });
        if (userMessages.length > 0) {
          store.recordUserInput(messageId - 1, userMessages[0].message, content);
        }
      }
    }, 500);
  });

  // ========== 情绪积累系统（用户发送消息时触发） ==========

  let emotionAnalysisInProgress = false;

  eventOn(tavern_events.MESSAGE_SENT, () => {
    const store = useMainStore(pinia);
    if (!store.settings.emotionEnabled) return;

    // 更新计数器
    const currentState = store.emotionState ?? {
      characters: [],
      userFloorsSinceLastAnalysis: 0,
      analysisCount: 0,
      lastAnalysisFloor: 0,
    };
    currentState.userFloorsSinceLastAnalysis++;

    // 检查是否达到触发间隔
    if (shouldTriggerEmotionAnalysis(currentState.userFloorsSinceLastAnalysis, store.settings.emotionInterval)) {
      triggerEmotionAnalysis(store, currentState);
    } else {
      store.updateEmotionState(currentState);
    }
  });

  async function triggerEmotionAnalysis(
    store: ReturnType<typeof useMainStore>,
    currentState: EmotionAccumulationState,
  ) {
    if (emotionAnalysisInProgress) return;
    emotionAnalysisInProgress = true;

    try {
      const currentFloor = getLastMessageId();
      const previousCharacters = currentState.characters.length > 0 ? currentState.characters : null;

      console.info('[智脑] 正在执行情绪积累分析...');
      const newCharacters = await executeEmotionAnalysis(previousCharacters, currentFloor);

      const newState: EmotionAccumulationState = {
        characters: newCharacters,
        userFloorsSinceLastAnalysis: 0,
        analysisCount: currentState.analysisCount + 1,
        lastAnalysisFloor: currentFloor,
      };
      store.updateEmotionState(newState);

      console.info(`[智脑] 情绪积累分析完成 (${newCharacters.length} 角色, 第${newState.analysisCount}次)`);
    } catch (error) {
      console.error('[智脑] 情绪积累分析失败:', error);
    } finally {
      emotionAnalysisInProgress = false;
    }
  }

  // ========== 提示词注入系统 ==========

  eventOn(tavern_events.CHAT_COMPLETION_SETTINGS_READY, completion => {
    const store = useMainStore(pinia);

    // --- 用户人格注入 ---
    if (store.settings.personaEnabled && store.persona.analyzedProfile) {
      injectPersonaIntoCompletion(completion.messages, store.persona.analyzedProfile, store.persona.rawInput);
    }

    // --- 大总结注入（每次生成请求时动态获取最新总结内容） ---
    const latestSummary = store.getLatestSummary();
    if (latestSummary && latestSummary.rawText) {
      const summaryInjection = buildSummaryInjectionText(latestSummary);
      if (summaryInjection) {
        // 使用 once: true 确保每次请求都重新注入最新内容
        injectPrompts(
          [
            {
              id: 'mqzn-grand-summary-' + Date.now(),
              role: 'system',
              content: summaryInjection,
              position: 'in_chat',
              depth: 8,
            },
          ],
          { once: true },
        );
      }
    }

    // --- 动态人设注入 ---
    if (store.settings.dynamicProfileEnabled && store.dynamicProfiles.length > 0) {
      const latestCaptured = store.capturedContents[store.capturedContents.length - 1];
      const scanText = latestCaptured?.content || '';
      const allNames = [...store.getAllCharacterNames(), ...store.getDreamtalkCharacterNames()];
      injectDynamicProfiles(store.dynamicProfiles, scanText, Array.from(new Set(allNames)));
    }

    // --- 神经链记忆激活 ---
    if (store.settings.memoryActivationEnabled) {
      const mergedMemories = store.getMergedCharacterMemories();
      if (mergedMemories.length > 0) {
        const latestCaptured = store.capturedContents[store.capturedContents.length - 1];
        const scanText = latestCaptured?.content || '';
        const allNames = store.getAllCharacterNames();
        const characterEntries = mergedMemories.map(m => ({
          name: m.characterName,
          aliases: m.aliases || [],
        }));
        const userName = SillyTavern.name1 || '{{user}}';
        injectNeuralChain(mergedMemories, scanText, allNames, characterEntries, userName);
      }
    }

    // --- 梦呓注入 ---
    if (store.settings.dreamtalkEnabled && store.dreamtalk) {
      injectDreamtalkIntoUserMessage(completion.messages, store);
    }

    // --- NSFW隔离层注入 ---
    if (isNsfwActive()) {
      const latestCaptured2 = store.capturedContents[store.capturedContents.length - 1];
      const scanText2 = latestCaptured2?.content || '';
      const allNames2 = [...store.getAllCharacterNames(), ...store.getDreamtalkCharacterNames()];
      const currentChars = scanCharacterNamesFromContent(scanText2, Array.from(new Set(allNames2)));
      injectNsfwData(store.nsfwMemories, store.nsfwDreamtalk, store.nsfwDynamicProfiles, currentChars);
    }

    // --- 倒果为因注入 ---
    if (store.settings.plotFateEnabled && store.plotFate) {
      injectPlotFate(store.plotFate);
    }

    // --- 情绪积累注入 ---
    if (store.settings.emotionEnabled && store.emotionState?.characters?.length) {
      injectEmotionState(store.emotionState.characters);
    }
  });

  // ========== 大总结注入文本构建 ==========

  function buildSummaryInjectionText(summary: GrandSummary): string {
    if (!summary.rawText) return '';
    // 只注入第一部分（叙事摘要），角色记忆通过 injectNeuralChain() 按在场角色条件注入
    const sections = summary.rawText.split(/---SECTION---/i);
    const narrativeSection = sections[0] || '';

    if (!narrativeSection.trim()) return '';

    const parts: string[] = [];
    parts.push(`<grand_summary version="${summary.version}" generated_at="${summary.generatedAt}">`);
    parts.push(narrativeSection.trim());
    parts.push('</grand_summary>');
    return parts.join('\n');
  }

  // ========== 梦呓注入函数 ==========

  function injectDreamtalkIntoUserMessage(
    messages: SillyTavern.SendingMessage[],
    store: ReturnType<typeof useMainStore>,
  ) {
    const dreamtalkData = store.dreamtalk;
    if (!dreamtalkData) return;

    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return;

    const lastUserMsg = messages[lastUserIdx];
    if (typeof lastUserMsg.content !== 'string') return;

    const allCharNames = [...store.getAllCharacterNames(), ...store.getDreamtalkCharacterNames()];
    const uniqueNames = Array.from(new Set(allCharNames));

    let latestContent = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && typeof messages[i].content === 'string') {
        latestContent = messages[i].content as string;
        break;
      }
    }
    const currentCharacters = scanCharacterNamesFromContent(latestContent + lastUserMsg.content, uniqueNames);

    const dreamtalkText = buildDreamtalkInjection(dreamtalkData, currentCharacters);
    lastUserMsg.content = dreamtalkText + '\n\n' + lastUserMsg.content;
    console.info(`[智脑] 梦呓已注入用户消息 (${currentCharacters.length} 角色匹配)`);
  }

  // ========== 梦呓分析触发 ==========

  async function triggerDreamtalkAnalysis(store: ReturnType<typeof useMainStore>) {
    store.setDreamtalkInProgress(true);
    try {
      console.info('[智脑] 正在分析用户行为模式（梦呓）...');
      const { dreamtalk, nsfwDreamtalk } = await executeDreamtalkAnalysis(store.userInputRecords, store.persona.rawInput);
      store.updateDreamtalk(dreamtalk);
      if (nsfwDreamtalk) {
        store.updateNsfwDreamtalk(nsfwDreamtalk);
        console.info('[智脑] NSFW梦呓数据已更新');
      }
      console.info(`[智脑] 梦呓分析完成 (${dreamtalk.characterInteractions.length} 角色交互模式)`);
    } catch (error) {
      console.error('[智脑] 梦呓分析失败:', error);
    } finally {
      store.setDreamtalkInProgress(false);
    }
  }

  async function ensureRecentFloorsVisible() {
    return ensureRecentFloorsVisibleCore('affected');
  }

  async function checkAndTriggerSummary(store: ReturnType<typeof useMainStore>) {
    if (store.summaryInProgress) return;

    if (!shouldTriggerSummary(store.capturedContents, store.lastSummaryAtMessageId, store.settings.summaryInterval)) {
      return;
    }

    store.setSummaryInProgress(true);
    console.info('[智脑] 触发大总结');

    try {
      // 获取待总结内容（已排除最新4条AI发言）
      const pendingContents = getContentsSinceLast(store.capturedContents, store.lastSummaryAtMessageId);
      if (pendingContents.length === 0) {
        console.info('[智脑] 排除最新楼层后无可总结内容，跳过');
        return;
      }

      const previousSummary = store.getLatestSummary();
      const { summary, dynamicProfiles, nsfwMemories, dateFormat } = await executeGrandSummary(pendingContents, previousSummary, store.dynamicProfiles, store.storyDateFormat);
      const summarizedMessageIds = getCapturedContentMessageIds(pendingContents);
      const summarizedUpTo = summarizedMessageIds[summarizedMessageIds.length - 1] ?? store.lastSummaryAtMessageId;

      // Toastr 弹窗警告：AI 输出的角色记忆为空
      const totalNewMemories = summary.characterMemories.reduce(
        (s, m) => s + (m.coreMemories?.length || 0) + (m.recentMemories?.length || 0),
        0,
      );
      if (totalNewMemories === 0) {
        console.warn('[智脑] ⚠️ AI 输出的角色记忆为空！可能是格式异常，建议重新总结');
        try {
          window.toastr?.warning(
            'AI 输出的角色记忆为空！可能是格式异常，建议重新总结',
            '⚠️ 明月秋青',
            { timeOut: 8000, extendedTimeOut: 3000 },
          );
        } catch(e) {}
      }

      store.addSummary(summary, summarizedUpTo, summarizedMessageIds);
      // 同步 rawText Section 2 到合并后的角色记忆（显示与注入一致）
      const mergedForSync = store.getMergedCharacterMemories();
      if (mergedForSync.length > 0) {
        const sections = summary.rawText.split(/---SECTION---/i);
        if (sections.length >= 2) {
          sections[1] = '\n' + buildMemorySectionText(mergedForSync);
          summary.rawText = sections.join('---SECTION---');
        }
      }
      if (dateFormat) store.storyDateFormat = dateFormat;
      for (const profile of dynamicProfiles) {
        store.updateDynamicProfile(profile);
      }

      // 存储NSFW记忆
      if (nsfwMemories.length > 0) {
        store.updateNsfwMemories(nsfwMemories);
        console.info(`[智脑] NSFW记忆已更新 (${nsfwMemories.length} 角色)`);
      }

      console.info(`[智脑] 大总结 v${summary.version} 完成 (${summary.characterMemories.length} 角色)`);

      const hiddenIds = await hideCapturedContentsWithUsers(pendingContents, 'affected');
      await ensureRecentFloorsVisible();
      if (hiddenIds.length > 0) {
        console.info(`[智脑] 已隐藏 ${hiddenIds.length} 个已总结楼层（保留最新 ${PRESERVE_RECENT_COUNT} 条AI发言）`);
      }

      // 大总结完成后触发梦呓分析
      triggerDreamtalkAnalysis(store);

      // 大总结完成后触发倒果为因分析
      if (store.settings.plotFateEnabled) {
        triggerPlotFateAnalysis(store);
      }
    } catch (error) {
      console.error('[智脑] 大总结失败:', error);
    } finally {
      store.setSummaryInProgress(false);

      // 总结期间可能又有新消息到达，500ms后检查是否需要二次总结
      setTimeout(() => {
        const newPending = getContentsSinceLast(store.capturedContents, store.lastSummaryAtMessageId);
        if (
          newPending.length >= store.settings.summaryInterval &&
          newPending.length > PRESERVE_RECENT_COUNT
        ) {
          console.info(`[智脑] 总结后有 ${newPending.length} 条新消息，准备二次总结`);
          checkAndTriggerSummary(store);
        }
      }, 500);
    }
  }

  // ========== 倒果为因分析触发 ==========

  async function triggerPlotFateAnalysis(store: ReturnType<typeof useMainStore>) {
    try {
      const latestSummary = store.getLatestSummary();
      if (!latestSummary) return;

      const recentContents = store.capturedContents.filter(c => c.messageId > store.lastSummaryAtMessageId);
      console.info('[智脑] 正在执行倒果为因分析...');

      const newState = await executePlotFateAnalysis(latestSummary, recentContents, store.plotFate);
      store.updatePlotFate(newState);

      if (newState.triggeredFate) {
        console.info(`[智脑] ⚡ 转折点就绪: "${newState.triggeredFate.description}"`);
      }
      console.info(`[智脑] 倒果为因完成 (节奏:${newState.currentRhythm}, ${newState.currentFates.length}果)`);
    } catch (error) {
      console.error('[智脑] 倒果为因分析失败:', error);
    }
  }

  // ========== 聊天切换时重载 ==========

  reloadOnChatChange();

  // ========== 卸载清理 ==========

  $(window).on('pagehide', () => {
    app.unmount();
    $app.remove();
    destroy();
  });

  console.info('[智脑] 明月秋青脚本已加载');
});
