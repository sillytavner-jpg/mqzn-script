# 明月秋青脚本 更新日志

> 基于 sanmingyue/tavern_dist v0.2.0 (mqzn-v0.2.0)

---

## [fix7+] - 当前开发版

### 修复
- **Bug8 - 隐藏楼层多两层**：`ensureRecentFloorsVisible` 内层函数调用 `getChatMessages` 只查可见消息，被隐藏的最新楼层查不到。改为合并可见+隐藏两个查询结果，确保能覆盖所有楼层

### 已还原
- 还原 `addSummary` v1 核心记忆合并修改（恢复原版逻辑）
- ~~还原~~ 恢复 `记忆条目:` 提示词标签（确认为角色库条目读取的必要修复）

---

## [fix7] - 2026-05

### 已还原
- 完全移除 `restoreDreamtalk` 函数及 UI 按钮（经确认原版已有 dreamtalkHistory + rollbackDreamtalk）
- 完全移除 `max_tokens` 参数（非问题根因）

### 修复
- **loadHistoryFloors**：原版只匹配 `<content>` 标签提取消息，无标签消息被跳过。改为优先匹配 `<content>`，无标签时移除 `<think>` 后取全文
- **addSummary v1**：原版 `n.coreMemories=[...n.recentMemories].slice(0,5)` 直接丢弃旧核心记忆，改为合并 `coreMemories + recentMemories` 后重新分配

### 新增
- 大总结面板楼层范围显示 `(#X-#Y, N层)`
- 提示词添加 `记忆条目:` 标签（已在 fix7+ 中还原）

---

## [fix6] - 2026-05

从 fix2 重建，避免 fix5 缺少总结撤回长度保护的回归问题。

包含 fix2 全部修复 + 以下新增：

---

## [fix5] - 已废弃

缺少总结撤回长度保护，已由 fix6 替代。

---

## [fix4] - 已废弃

---

## [fix3] - 已废弃

---

## [fix2] - 最早备份

### 修复
- **Bug2 - 总结撤回/恢复**：新增 `summaryHistory` store + `restoreLastSummary` 函数 + `summaries.length<=1` 保护。添加快捷撤回/恢复 UI 按钮
- **Bug4 - 记忆条目合成**：多角色 memories 拼接改用追加 `+=` 防止覆盖
- **Bug5 - 人称修正**：`"我是你哥哥Mingyue"` → `"我是玩家"`
- **Bug1 - 我们按钮**：`c.value=!c.value` 切换逻辑修复

---
