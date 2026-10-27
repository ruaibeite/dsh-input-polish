# @ruaibeite/dsh-input-polish

在 DSH 输入框旁加一个 ✨ 按钮：把草稿交给模型重写成一条更清楚的请求，然后**原地替换**输入框内容。改写会读当前会话最近的上下文，所以「它」指代的对象、刚才讨论过的约束都不会丢。

> 输入框里点一下 → 由模型改写你正在写的那句话 → 结果回填到同一个输入框（作为一次可撤销的编辑）。

## 它做什么

- **按钮位置**：输入框右下工具区（`conversation.input.right`），与模型选择器同一组、紧邻其左侧；语音按钮独占 `conversation.input.activity`（`single` 槽位），所以无法插进语音按钮与其邻居之间 —— 这是 DSH 槽位体系的结构限制，不是本插件的取舍。
- **改写什么**：你正在写的草稿本身。规则写死在系统提示里：保留语言、保留文件路径/标识符/命令/数字/URL、补齐目标与约束、不臆造需求、草稿已经够好就原样返回、**绝不替用户回答问题**。
- **参考什么上下文**：当前会话最近 8 条消息（可配置），在 host 侧用 `session.deriveMessages()` 取，压平成文本后作为「for context only」附在草稿前。
- **用哪个模型**：优先用这个会话**当前正在用的**模型路由（`session.requestHeader().config`），取不到时退回部署默认（`agentDefaultModel.currentSelection()`）。不写死 provider/model。
- **怎么回填**：`inputActions.setDraft(text)` —— 与人工编辑走同一条编辑器路径，合并进历史，一次撤销即可还原；光标落在末尾。
- **失败**：按钮旁显示一行短错误（超时 / 无可用模型路由 / 模型返回空），草稿保持不变。

## 安装

```sh
dsh plugin --profile <你的 profile> add github:ruaibeite/dsh-input-polish
```

然后重启 DSH（host 半边要重新组合）。桌面端也可以在「插件」页里从 Git 仓库安装。

## 使用

1. 在输入框里写下粗糙的想法（中文、英文都行）；
2. 点右侧的 ✨；
3. 等一小会儿（推理模型可能要十几秒），草稿被替换成改写后的版本；
4. 不满意就 ⌘Z / Ctrl+Z，或再点一次 ✨ 重新生成。

## 什么时候按钮不可用

| 状态 | 原因 |
|---|---|
| 草稿为空 | 没有可改写的内容 |
| 草稿里有引用 chip（`@文件`、文件夹、会话引用）或行首 `/命令` | 整段替换会丢掉这些 chip —— 宁可不改，也不悄悄删掉你的引用 |
| 正在提交（`adjudicating` / `submitting`） | 这时写草稿会破坏正在序列化的请求 |

正在生成回复时**可以**用（它只改草稿，不碰提交）。

## 配置

在 profile 的 patch 层里覆盖，或直接改本包自带的 `cordis.patch.yml`：

```yaml
- insert:
    - id: input-polish
      name: '@ruaibeite/dsh-input-polish'
      config:
        timeoutMs: 45000        # 单次改写的最长时间，超时返回 504、草稿不动
        maxInputChars: 8000     # 超过就拒绝（413），避免把整份文件塞进提示
        contextMessages: 8      # 参考上下文取最近几条消息；0 = 不带上下文
        temperature: 0.2        # 低温度，改写要稳
```

## 实现

```
lib/index.js     host 半边：注册 POST /dsh-input-polish/rewrite，
                 取会话最近消息与模型路由，调用 ctx.llm.stream，
                 组装文本后以 JSON 返回（含超时与错误码）
client/client.js 浏览器半边：手写的预构建 bundle（window.__ModuleLoader__），
                 注册进 conversation.input.right，读 useInput(s=>s.draft)、
                 写 inputActions.setDraft
```

为什么用 HTTP 路由而不是自定义 remote：第三方插件无法自己贡献 typert remote（构建期生成、浏览器侧是固定清单），而宿主的 `webServer.register()` 是插件能用的正规通道 —— 市场插件也是这么做的。

为什么不用 `setDraft` 处理带 chip 的草稿：`setDraft` 会清空重建编辑区，chip 会全部丢失，所以插件在 `occurrences.length > 0` 或 `phase !== 'plain'` 时直接禁用。

## 开发

```sh
node --check lib/index.js
node --check client/client.js
npm test          # 18 项 host 纯函数 + 13 项客户端外壳/注册冒烟测试
```

## 已知限制

- 只改写「当前草稿」，不支持「选中一段再改」：宿主没有设置选区的 API（`captureInsertion()` 给的区间只读）。
- 一次只处理一个会话的草稿；切会话时按钮状态会重置。
- 依赖宿主的 `webServer`、`llm`、`sessions`、`agentDefaultModel` 服务；精简组合（无沙箱 web 宿主）上按钮仍会显示，但点下去会得到「无可用模型路由」的错误提示。

## English

A ✨ button in the composer's trailing control cluster rewrites the draft in place with the model, using the last few messages of the conversation as context. It preserves language, paths, identifiers and commands, never answers the request itself, and writes the result back through the same `setDraft` path a human edit uses (so one undo restores the original). Chips and in-flight submissions disable the button instead of silently dropping references. Install with `dsh plugin --profile <name> add github:ruaibeite/dsh-input-polish` and restart DSH.

## License

MIT
