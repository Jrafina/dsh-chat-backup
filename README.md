# 对话备份 · Conversation Backup for DSH

一个 DSH 插件：在输入框下方加一个「对话备份」按钮，点一下就把

1. 当前对话抽成一问一答的 `对话.md` —— 只有你的提问 + 每轮 DSH 的最终文字回答，不含思考过程、工具调用、中间步骤；
2. 这段对话**最近一轮真正产出文件的那一轮**留在磁盘上的文件，打包成 `附件.zip`；
3. 两者一起上传到 Cloudflare R2：`<yyyy-mm-dd>--<对话标题>/`。

```
2026-11-04--帮我画一只赛博朋克猫/
├── 对话.md
└── 附件.zip
```

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| `chat-backup/` | 插件本体：Host 侧路由（渲染 / 打包 / SigV4 上传）+ Client 侧按钮 |
| [`chat-backup/README.md`](chat-backup/README.md) | 完整行为说明、配置项、端点协议 |
| `dev/` | 开发期脚本：解 zstd 会话日志、离线 smoke、R2 连通性与生命周期测试 |

## 安装

把 `chat-backup/` 作为 bundle 装进 profile：

```text
plugin_manager  action: install_bundle  target: <chat-backup 的绝对路径>
```

或手动写进 profile 的 `package.json`：

```json
{
  "dependencies": { "@local/dsh-chat-backup": "link:<chat-backup 的绝对路径>" },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@local/dsh-chat-backup"
      ]
    }
  }
}
```

然后在该 profile 目录里 `pnpm install`，**完全重启** DSH（宿主只在启动时组装插件树）。

## 配置

凭据只放在 profile 的 `cordis.patch.yml`（或环境变量），**不要提交进仓库**：

```yaml
- id: chat-backup
  name: '@local/dsh-chat-backup'
  config:
    accountId: '<R2 Account ID>'
    accessKeyId: '<R2 Access Key ID>'
    secretAccessKey: '<R2 Secret Access Key>'
    bucket: '<bucket name>'
```

也可以改用环境变量：`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET`。

其余可选项（`prefix`、`maxFileBytes`、`maxTotalBytes`、`exclude`、`injectedMessageKinds`）见 [`chat-backup/README.md`](chat-backup/README.md)。

## 隐私

- 本仓库不含任何真实凭据、账号 ID、桶名或会话记录；
- 插件只读取当前会话日志，以及工作目录里**本轮真正产出的文件**，跳过 `node_modules`、`.git`、`.dsh`、所有以 `.` 开头的路径和 `exclude` 命中的片段；
- 上传目标只有你在配置里指定的那个 R2 桶，没有别的出口。

## 开发

```text
node dev/dump.mjs   <session.v4.jsonl.zstd>   # 解出会话事件
node dev/kinds.mjs  <session.v4.jsonl.zstd>   # 统计 user 消息的 source.kind
node dev/preview.mjs <session.v4.jsonl.zstd>  # 用插件自己的抽取逻辑渲染一份 transcript
node dev/smoke.mjs                            # 离线跑一遍路由，产出 ZIP
node dev/live.mjs                             # 真传一次 R2
node dev/flow.mjs                             # 备份生命周期全流程（首次 / 重复 / 追加 / 替换 / 兜底）
node dev/r2.mjs list                          # R2 连通性 / 列举
```

`dev/live.mjs`、`dev/flow.mjs`、`dev/r2.mjs` 只从环境变量读凭据，不接受硬编码。
