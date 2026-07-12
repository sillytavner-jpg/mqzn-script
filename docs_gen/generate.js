const { Document, Packer, Paragraph, TextRun, HeadingLevel, TableOfContents, AlignmentType } = require('docx');
const fs = require('fs');

const doc = new Document({
    sections: [{
        children: [
            new Paragraph({
                text: "明月秋青智脑 — 使用说明书",
                heading: HeadingLevel.TITLE,
                alignment: AlignmentType.CENTER
            }),
            new Paragraph({
                text: "v4.x",
                alignment: AlignmentType.CENTER
            }),
            new Paragraph({ text: "" }),
            new Paragraph({ text: "" }),
            new Paragraph({
                text: "一、智脑是什么？",
                heading: HeadingLevel.HEADING_1
            }),
            new Paragraph({
                children: [
                    new TextRun("智脑是酒馆的 AI 聊天记忆管家。你在酒馆中正常和角色聊天，它在后台做三件事：\n"),
                    new TextRun("记 — 自动总结聊天内容，提炼角色记忆。\n"),
                    new TextRun("理 — 分析角色关系、情绪变化、知识图谱、动态人设以及你的行为偏好。\n"),
                    new TextRun("用 — 把这些记忆与状态精准注入到 AI 上下文中，让角色越聊越懂你，越聊越记得你。")
                ]
            }),
            new Paragraph({
                text: "二、快速上手",
                heading: HeadingLevel.HEADING_1
            }),
            new Paragraph({
                children: [
                    new TextRun({ text: "第一步：什么都不用调\n", bold: true }),
                    new TextRun("装好直接用，默认的各项开关和配置就是经过验证的最优配置。\n"),
                    new TextRun({ text: "第二步：开始聊天\n", bold: true }),
                    new TextRun("正常玩酒馆就行。每轮对话结束后，智脑会进行小总结；积累 N 轮后，触发大总结V2，在后台进行全面盘点。静默运行，无需人工干预。")
                ]
            }),
            new Paragraph({
                text: "三、面板与核心模块介绍",
                heading: HeadingLevel.HEADING_1
            }),
            new Paragraph({ text: "1. 总览 — 仪表盘", heading: HeadingLevel.HEADING_2 }),
            new Paragraph({ text: "显示已捕获的记录情况，允许你手动启动大总结、重新总结，或者启动 批量总结V2 以消化旧的聊天记录。" }),

            new Paragraph({ text: "2. 角色库 & 记忆控制", heading: HeadingLevel.HEADING_2 }),
            new Paragraph({ text: "分为核心记忆和近期记忆：\n核心记忆：包含角色重要经历，可开启智能语义召回（支持硅基流动的BGE-M3模型），让AI精准关联历史事件。\n近期记忆：保存最近几轮动态，无条件全部注入。" }),
            
            new Paragraph({ text: "3. 动态人设 (Dynamic Profile V2)", heading: HeadingLevel.HEADING_2 }),
            new Paragraph({ text: "使用双层结构进行刻画：事实层 (客观状态) 和表现层 (性格变化)。采用防极端化策略进行递进，取代了旧版的单一刻画。" }),
            
            new Paragraph({ text: "4. 梦呓系统 (Dreamtalk V2)", heading: HeadingLevel.HEADING_2 }),
            new Paragraph({ text: "升级为“行为翻译手册”。AI会解析你的互动模式，并带有防误读（prevent）机制，使得角色的回复贴合你的习惯。按重要性截断防Token爆炸。" }),

            new Paragraph({ text: "5. 关系档案", heading: HeadingLevel.HEADING_2 }),
            new Paragraph({ text: "纯手动触发的高级功能，通过分析各个角色间的互动和关联，可视化亲密度，能识别角色与你或其他角色的关系张力与态度。" }),

            new Paragraph({ text: "6. 知识图谱 (Knowledge Graph)", heading: HeadingLevel.HEADING_2 }),
            new Paragraph({ text: "伴随每轮小总结同步产出。记录物品的状态、归属和地点信息，构建网状连接，并根据场景上下文智能提取，防止细节丢失。" }),

            new Paragraph({ text: "7. 事实信息强调 (Fact Emphasis)", heading: HeadingLevel.HEADING_2 }),
            new Paragraph({ text: "每次AI回复前，前端会自动把最近的时间、地点和确定的事实提取出来，附带在你的消息后，防止AI出现时空错乱。" }),

            new Paragraph({ text: "8. 世界推进与剧情导演", heading: HeadingLevel.HEADING_2 }),
            new Paragraph({ text: "世界推进模块在后台悄悄推演非在场角色的行动和世界线变动。\n剧情导演模块支持预先讨论剧情大纲，并在正式游戏时由AI监督情节走向，防止偏离预定轨道。" }),

            new Paragraph({ text: "9. 世界书蒸馏", heading: HeadingLevel.HEADING_2 }),
            new Paragraph({ text: "将冗长复杂的外部设定，由AI提炼分类为结构化摘要，为游戏提供精准背景支持。" }),

            new Paragraph({
                text: "四、进阶与功能开关",
                heading: HeadingLevel.HEADING_1
            }),
            new Paragraph({ text: "默认情况下，绝大多数功能都会开启（世界推进默认关闭）。\n在设置面板中，你可以：\n- 配置自定义 API 渠道与模型（推荐大模型如 Gemini-1.5-Pro / DeepSeek V4 等）。\n- 调节各种功能的间隔时间与记忆保留条数。\n- 设置多个用户人设进行切换。\n- 导入与导出历史记忆数据进行备份。" }),
            
            new Paragraph({
                text: "五、常见问题排查",
                heading: HeadingLevel.HEADING_1
            }),
            new Paragraph({ text: "Q：弹出“总结失败”怎么办？\nA：在总览中点击“重新总结”。若批量总结卡住，系统内置了最高3次的重试及指数退避机制。\n\nQ：记忆偏移怎么处理？\nA：前往角色库 -> 追忆面板，可手动把“写偏”的记忆编辑修正或者降级清除。" })
        ]
    }]
});

Packer.toBuffer(doc).then((buffer) => {
    fs.writeFileSync("D:/桌面/游戏/酒馆/明月秋青智脑-使用说明书-V4.docx", buffer);
    console.log("Created D:/桌面/游戏/酒馆/明月秋青智脑-使用说明书-V4.docx");
});
