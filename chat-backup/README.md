# 对话备份 · Conversation Backup

DSH 插件：在输入框下方加一个「对话备份」按钮，点一下就

1. 从当前会话日志里抽出一问一答的对话文件（**只有用户提问 + 该轮 DSH 的最终文字回答**，不含思考过程、工具调用、中间步骤）；
2. 找出这段对话**最近一轮真正产出文件的那一轮**留在磁盘上的文件（已经删掉的过程文件自然不在其中），打包成 ZIP；
3. 两个文件一起上传到 Cloudflare R2，目录为 `<yyyy-mm-dd>--<对话标题>/`。

```
2026-11-04--帮我画一只赛博朋克猫/
├── 对话.md        ← 提问与回答
└── 附件.zip       ← 最近一轮生成的文件（没有文件时不生成）

_sessions/
└── session-xxxx.json   ← 这个会话的备份索引（防止重复备份）
```

## 重复备份保护

- 这个对话**没备份过** → 正常备份。
- **备份过、之后没有新提问** → 按钮变成「已备份过 · 无新增提问」，不重复上传；旁边给「重新备份 / 取消」，想覆盖时仍可手动来一次。
- **备份过、之后又追加了提问** → 按钮变成「已备份过 · 追加 N 个提问」，点「追加备份」才会动手：先把完整的新对话传到新目录，再删掉 R2 上的旧目录，最后更新索引。**新目录的日期是这次备份的日期**。
- 同一天、同一标题重备时目录名相同，新文件直接覆盖旧文件，删除阶段会自动跳过它们，不会把刚上传的内容删掉。
- 删除失败会整单报错（`delete-failed`）且不更新索引，再点一次即可重试，旧备份不会变成孤儿。
- 索引丢失（比如手工删了 `_sessions/`）时会退一步：按「`--<标题>`」找桶里的同名目录，再读该目录下 `对话.md` 的会话 ID 核对，命中就仍然算作已备份。

## 安装

```bash
dsh plugin --profile <profile> add \
  https://github.com/Jrafina/dsh-chat-backup/releases/download/v1.1.0/dsh-chat-backup-1.1.0.tgz
```

装完完全退出并重启 DSH。`desktop` profile 由桌面应用独占，CLI 不接受，改用应用内「设置 → 插件」粘贴同一个 URL。

从源码链接安装：`dsh plugin --profile <profile> add <本目录的绝对路径>`。

## 配置

配置写在**你自己** profile 的 `cordis.patch.yml` 里（`~/.dsh/profiles/<profile>/cordis.patch.yml`），不要提交进这个仓库：

```yaml
- id: chat-backup
  name: '@local/dsh-chat-backup'
  config:
    accountId: '<R2 Account ID>'
    accessKeyId: '<R2 Access Key ID>'
    secretAccessKey: '<R2 Secret Access Key>'
    bucket: '<bucket name>'
```

也可以改用环境变量（配置留空时读取）：`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET`。

其余可选项：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `prefix` | `''` | 桶内前缀，例如 `dsh` → `dsh/2026-11-04--<标题>/` |
| `maxFileBytes` | 25 MiB | 单个文件上限，超过的文件记入 `skipped` |
| `maxTotalBytes` | 100 MiB | 整个 ZIP 上限 |
| `exclude` | `[]` | 额外的排除片段（大小写不敏感的子串匹配），例如 `['.env', 'tmp/']` |
| `injectedMessageKinds` | `[]` | 追加「视为注入上下文」的 `source.kind`，见下 |

R2 的 Access Key 需要该桶的 **Object Read & Write** 权限；桶不必公开。

## 行为细节

- **提问与回答**：只有 `source.kind === 'user'` 的用户消息才算提问。DSH 会把运行时上下文（`runtime-context`）、技能清单（`skill-catalog`）、时间戳（`time-context`）、审批通知（`user-approval`）也作为 `role: 'user'` 的消息插进对话，这些一律跳过 —— 否则它们会被当成提问、把真正的回答挤到一边。出现新的注入类型时，用 `injectedMessageKinds` 追加即可，不用改代码。
- **回答**：取该轮**最后一段**助手文字。一轮里模型常常先说「我先看一下目录」再去调工具，那些是进度播报；最后那段才是真正的答复。
- **对话标题**取 DSH 已生成的会话标题；没有标题时退回第一条提问的前 60 字。
- **打包范围**：从最近一次 `workspace/changes` 记录往前找，取第一条仍有存活文件的那一轮。这样即使最后一句是纯问答，也会打包上一轮真正产出的文件。
- **永不打包**：`node_modules`、`.git`、`.dsh`、任何以 `.` 开头的文件/目录、以及 `exclude` 命中的路径。
- 只上传、不落本地盘；失败时按钮变红，鼠标悬停可看原因，再点一次即重试。

## 端点

Host 侧只有一个路由：`POST /api/chat-backup/run`，body `{ "sessionId": "...", "mode": "auto" }`。

`mode` 取 `auto`（默认）或 `replace`（用户确认追加后的替换）；另可传 `"dryRun": true` 只预览不上传。

```json
{ "ok": true, "folder": "2026-11-04--标题", "replaced": false, "deleted": [],
  "objects": [{ "key": "...", "bytes": 0 }], "files": [{ "path": "...", "bytes": 0 }], "skipped": [] }
```

需要用户决定时返回 `ok: false` + `code`：

```json
{ "ok": false, "code": "needs-confirm", "newQuestions": 1,
  "message": "这个对话在 2026-11-05 19:57 备份过，之后又追加了 1 个提问。",
  "previous": { "localTime": "2026-11-05 19:57", "folder": "...", "turns": 3, "objects": 2 } }
```

`code` 可能是 `needs-confirm`、`already-backed-up`、`not-configured`、`no-session`、
`upload-failed`、`delete-failed`。
