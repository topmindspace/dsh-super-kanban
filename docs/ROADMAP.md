# 产品路线图

Super Kanban 把多个 DSH 会话聚合成可追溯的任务，支持项目与日程、任务验收、产物溯源和续做交接。会话运行、审批和工作树操作沿用 DSH 与 Git。已交付功能见 [变更记录](../CHANGELOG.md)。

## 待评估方向

| 方向 | 评估重点 |
| --- | --- |
| 项目规划 | 负责人和依赖时间线需要考虑跨项目关系与多人协作时的写入冲突。 |
| 任务溯源 | Git 提交与 PR 链接需要可验证的来源。会话全文检索优先复用 DSH。 |
| 项目费用 | 需要可靠的提供方计费数据与项目归属，再评估费用汇总。 |
| 恢复和协作 | 当前的本机 JSON 备份用于恢复看板。跨环境同步需先明确冲突和版本处理。 |

## 快聊与旁会话

快聊适合短问答、连续追问、写提示词、解释、总结、润色和中英翻译，使用看板选择的模型。记录只保存在当前窗口的内存里，刷新窗口或点「新对话」即清空。需要长期保留会话、调用工具或继续执行时，可在 DSH 开启会话，也可以把快聊的回答放入会话输入框。DSH 的可继续子会话能力也可用于这类流程。[DSH 可继续子会话](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.md) · [社区旁会话插件](https://github.com/123dbl/dsh-side-session)
