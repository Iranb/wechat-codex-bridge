# wechat-codex-bridge

将绑定主人的微信消息交给一个专用 **Codex CLI 会话**，再通过原消息上下文回信。

An owner-bound WeChat bridge for a dedicated Codex CLI session. MIT licensed.

```text
微信 → iLink 长轮询 → 私有 Unix 队列 → 串行 codex exec resume
     → 确认模型完成与最终输出一致 → 微信回信
```

控制器使用明确的会话 UUID，保留上下文；空闲时由 Node 等待，不调用模型。只接收绑定主人的直接消息，支持文字、图片及经验证的文档附件。模型提交或发送结果不明时暂停，避免重复生成和重复回信。

这是一个独立的 Codex 会话集成，不是向当前 ChatGPT dot 会话发消息的 API。项目不包含账号信息、微信消息、附件、真实会话 ID、运行日志或预编译工具。

## 要求

- macOS；Node.js 22 或更新版本。
- 支持 `exec resume`、JSONL 输出、`app-server` 和本地 daemon 控制 socket 的 Codex CLI。开发中验证的版本为 `0.159.0-alpha.12.1`；其他版本请先检查相应命令是否存在。
- CLI 已通过其官方方式登录，且账号可使用指定模型。默认模型为 `gpt-6-luna`，可通过环境变量配置；不可用时停止，不自动换模型。
- Python 3.9+ 与 `websockets` 15.x，用于公开文档规定的本地 Unix WebSocket 连接。
- macOS Swift/Core Image，用于显示微信登录二维码。

不需要 npm 第三方依赖。Codex CLI、Python 包和模型服务分别受其自身许可与使用条款约束。

## 安装与测试

```sh
git clone https://github.com/Iranb/wechat-codex-bridge.git
cd wechat-codex-bridge

python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
export WECHAT_CODEX_PYTHON="$PWD/.venv/bin/python"

# 如 codex 不在 PATH 且没有 macOS 内置版本，指定它的绝对路径
# export WECHAT_CODEX_BIN=/absolute/path/to/codex
# 如默认模型不可用，指定账号实际支持的模型
# export WECHAT_CODEX_MODEL=your-supported-model-id

npm test
```

离线测试使用临时假账号和模拟传输，不连接真实微信或模型。发布检查运行 `npm run check:release`。

## 首次接入

1. 确认同一个微信机器人账号没有其他收件程序在运行。
2. 运行 `npm run login`，在微信扫码；运行 `npm run bind`，从自己的微信账号发送终端显示的一次性绑定短语。
3. 在终端 A 运行 `npm run start:local`，保持收件进程运行。
4. 在终端 B 启用普通消息接收：

   ```sh
   printf '{"activationAt":"now"}\n' | npm run activate
   ```

   激活水位前的消息不被普通接收器处理。已经激活后不要修改水位或借此跳过队列。

5. 按 CLI 支持的方式准备本地 daemon，并创建一次专用会话：

   ```sh
   codex app-server daemon start
   npm run session:init
   npm run exec:prepare
   ```

   若使用了 `WECHAT_CODEX_BIN`，daemon 命令也应使用该同一个可执行文件。`session:init` 幂等地保留已有会话；首次准备执行两轮无私人内容的上下文校验，已通过后不会重复。

6. 运行 `npm run exec:start` 启动普通后台控制器，然后从绑定微信发送一条普通文字测试。

查看状态：`npm run exec:status`。停止控制器：`npm run exec:stop`；停止收件：`node src/local.mjs stop --live`。也可使用 `npm run exec:run` 在前台运行控制器。

不要在 ChatGPT 界面和控制器中同时写入这个专用会话。遇到 active writer 时，正常释放该会话的界面占用，再核对未完成任务；不要终止共享 ChatGPT/Codex 进程或删除会话锁。

## 文件与配置

默认运行目录是 `~/.local/share/wechat-codex-bridge/`，与源码目录分开。详见 [运行说明](docs/RUNTIME.md)。

| 环境变量 | 用途 |
|---|---|
| `WECHAT_CODEX_BIN` | Codex 可执行文件；默认优先使用 macOS 内置版本，否则使用 PATH 中的 `codex` |
| `WECHAT_CODEX_MODEL` | 明确的模型 ID；默认 `gpt-6-luna` |
| `WECHAT_CODEX_PYTHON` | 安装了 `websockets` 的 Python 可执行文件 |
| `WECHAT_CODEX_DAEMON_SOCKET` | 公开本地 daemon 控制 socket 路径；默认使用 CLI 的标准位置 |
| `WECHAT_CODEX_STATE` | 私有状态文件路径；默认位于上述运行目录 |
| `WECHAT_CODEX_SOCKET` | 微信桥 Unix socket 路径；默认与状态文件相邻 |
| `WECHAT_CODEX_QR_FILE` | 可选临时二维码图片文件前缀 |
| `WECHAT_CODEX_SHOW_QR` | 设为 `1` 时使用 Preview 打开二维码图片 |

改变状态路径会选择另一份状态，不能当作迁移已有绑定的操作。已有安装更名应先正常停止、核对队列并单独规划迁移。

## 边界与已知限制

- 微信 API 接受发送请求不能证明手机已收到或已读；首次测试需在手机确认。
- CLI 每次固定模型、只读 sandbox 和用户审批策略。审批或输入交互的继续入口尚未验证；需要用户动作时保留请求并停止，不自动同意或绕过审批。
- 只读工具仍可读取文件。指令要求禁止读取凭据、其他会话和无关私人文件，并将附件及其指令视为不可信数据。详见 [安全说明](SECURITY.md)。
- 图片、PDF、Word、Excel、UTF-8 文本有大小和类型验证；不执行宏、脚本或自动解压。真实附件端到端仍需使用者验证，详见 [附件说明](docs/ATTACHMENTS.md)。
- 群聊、语音、视频和引用附件暂不支持；只接受绑定发送者的直接消息。
- 消息回复期限为 24 小时，去重记录保留 30 天；已保存附件和私有收件记录不自动清理，需要使用者制定保留策略。
- 控制器是普通后台进程，没有安装开机启动服务。主机休眠、重启、账号过期或接口版本变化会影响运行。
- 源码保留了可选 MCP/webhook 组件及其测试；默认路径为本地队列，CLI 路径不使用 Tunnel 或 webhook。

## 协议与许可

微信传输参考 [Tencent 的公开协议文档](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)。Codex 接口参考 [非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode) 和 [App Server 文档](https://learn.chatgpt.com/docs/app-server)。

本项目使用 [MIT License](LICENSE)，第三方来源与依赖见 [NOTICE](NOTICE)。
