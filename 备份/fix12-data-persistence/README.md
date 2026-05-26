# fix12-data-persistence

> 版本：v0.2.0-fix12
> 状态：**已修复** settings 丢失 bug（`mainStore.ts` 含补丁）
> Git commit：`1b5ee50` / `8b9ec94`

---

## 定位

这是 **fix13 Token 重构之前**的最后一个稳定版本。fix13 之后做了大幅度的总结逻辑重构（AI 不再接收旧总结，改为代码自动拼接），而 fix12 保留了原始设计：**每次总结 AI 都接收完整旧总结 + 新日志**。

---

## 本版本改动

### 1. 数据持久化方案修正（核心改动）

| | fix11 | fix12 |
|---|---|---|
| 主存储 | `type: 'global'` | `type: 'chat'` + `type: 'script'` |
| 备份存储 | 无 | `type: 'script'` 硬编码 `script_id='mqzn-script-data'` |
| 加载策略 | 单层 | 三层回退（主存储 → 跨版本备份 → 空数据） |
| 保存策略 | 单写 | 双写（主存储 + 跨版本备份） |

**为什么放弃 `type: 'global'`**：ST 底层不可靠，换版本后 script_id 变化会导致数据丢失。fix12 改为 `type: 'chat'`（聊天级存储，安全稳定）+ 硬编码 ID 做跨版本备份。

**加载逻辑（`tryReadData`）**：
1. 先读 `type:'chat'` + `type:'script'`（正常路径）
2. 为空时从硬编码 `script_id='mqzn-script-data'` 恢复（换版本回退）
3. 都没有则初始化空数据

**自动保存（`watchEffect`）**：
- 每次数据变更自动双写：主存储 + 跨版本备份

### 2. max_tokens 提升

`src/utils/apiCaller.ts`：`max_tokens: 8192` → `65536`，支持更大的总结输出。

### 3. 总结后二次检查

总结完成后 500ms 递归检查是否有新未总结内容，有则自动触发。

### ⚠️ 4. [已修复] 设置刷新后全部重置

**症状**：刷新页面后，所有设置（API URL/Key/Model、开关状态、人设等）全部恢复默认值。

**根因**：`type:'script'` 变量在 ST 页面刷新时不持久化。所有 settings 通过 `replaceVariables({type:'script'})` 保存，刷新后全丢。

**修复 v1**（`_mqzn_settings` 嵌入 `type:'chat'`，❌ 已废弃）：
- `chatWithSettings._mqzn_settings = scriptData`，整个对象存 `type:'chat'`
- 失败原因：`replaceVariables` 对大对象可能序列化失败，或 ST 底层不保留未知 key

**修复 v2**（**localStorage，✅ 当前方案**）：
- **保存时**：`localStorage.setItem('mqzn_global_settings', JSON.stringify(scriptData))` — 全局持久化
- **加载时**：`localStorage.getItem('mqzn_global_settings')` — 优先级最高，script 变量和 chat 内嵌仅作兜底
- 直接绕过 ST 变量系统，不再依赖 `replaceVariables`/`getVariables` 的不可靠行为
- `type:'chat'` 只存聊天数据，不再嵌入 settings（避免大对象序列化风险）

---

## 与 fix13 之后版本的关键差异

| 特性 | fix12（本版） | fix13+ |
|---|---|---|
| **总结时旧内容处理** | AI 接收完整旧总结 | AI 只看新日志，代码拼接旧事件 |
| **Token 消耗** | 随总结次数递增 | 基本固定 |
| **事件序号** | AI 输出 `[#N][日期]` | 代码自动生成 `[#N]` |
| **角色记忆上限** | 核心记忆最多 12 条 | 无上限 |
| **记忆排序** | 无特殊处理 | 按 AI 原始编号顺序 |
| **记忆判定** | AI 直接标核心/近期 | 先生成后对比，代码解析"最终核心" |
| **总结校验** | 角色记忆锐减 >50% 则拒绝 | 总记忆=0 或 新事件=0 则拒绝 |
| **v1 rawText** | 直接用 AI 原始输出 | 代码重建 Section 2 格式 |

---

## 何时恢复此版本

如果 fix13+ 的代码拼接逻辑出现问题（如旧事件丢失、拼接错乱等），可以回退到此版本。回退方式：

1. 将 `fix12-data-persistence/` 下的源码替换当前 `src/` → 编译
2. 或在 SillyTavern 中直接导入编译好的 `明月秋青脚本-fix12.json`（同目录下）

注意：恢复此版本后，AI 每次总结会接收完整的旧总结内容，Token 消耗会随楼层数增长。
