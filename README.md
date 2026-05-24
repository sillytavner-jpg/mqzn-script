# 明月秋青脚本

> SillyTavern 智能总结与角色记忆管理脚本

## 快速开始

### 方式一：CDN 直链（推荐，无需安装任何东西）

在 SillyTavern 扩展设置中，添加自定义脚本：

```
https://cdn.jsdelivr.net/gh/sillytavner-jpg/mqzn-script@master/index.js
```

保存刷新即可，无需 Node.js、无需本地服务器。

### 方式二：本地服务器

<details>
<summary>点击展开</summary>

#### 1. 环境要求

- [Node.js](https://nodejs.org)（推荐 LTS 版本）

#### 2. 启动

双击 `start.bat` 一键启动本地服务器。

#### 3. 配置 SillyTavern

在 SillyTavern 扩展设置中，添加自定义脚本：

```
http://localhost:8888/index.js
```

</details>

## 文件说明

| 文件 | 说明 |
|------|------|
| `index.js` | 主脚本，SillyTavern 加载此文件 |
| `server.js` | 本地 HTTP 服务器，提供脚本文件 |
| `start.bat` | 一键启动脚本 |

## 功能

- 自动捕获聊天楼层
- 读取历史楼层补录
- 大总结（角色记忆 / 剧情摘要 / 动态人设）
- 角色库（记忆条目管理）
- 梦呓分析（用户行为分析）
- 记忆激活注入

## 许可

基于 [sanmingyue/tavern_dist](https://github.com/sanmingyue/tavern_dist) 修改。
