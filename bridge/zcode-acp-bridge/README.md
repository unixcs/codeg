# zcode-acp-bridge

ACP（Agent Client Protocol）宿主 ⇄ ZCode CLI（`zcode app-server --stdio`）适配桥。
零宿主改动，把 ZCode 的模型/思考深度选择、`/compact` 手动压缩带进 [codeg](https://github.com/spacering-net/codeg) 等 ACP 宿主。

- 无第三方依赖，Node ≥ 18
- 一个 zcode 子进程 ≈ 300MB 常驻：桥内置闲置回收（默认 10min）+ 看门狗，长会话安全

## 快速开始

codeg → Settings → Custom Agents 添加（`zcode-acp-bridge` 需在 PATH，或写绝对路径）：

```json
{
  "name": "zcode",
  "brief": "ZCode CLI",
  "command": "zcode-acp-bridge",
  "protocol": "acp",
  "args": [],
  "env": {}
}
```

底栏即出现「模型 / 思考深度 / 模式」三个 config option 下拉；斜杠菜单出现 `/compact`。

## 模型清单：三层合并

| 层 | 来源 | 控制 |
|---|---|---|
| 手动层 | `BRIDGE_MODELS`（排最前） | 环境变量 |
| 实时层 | `session/read` 返回的会话可用模型 | 自动 |
| 配置层 | `$HOME/.zcode/v2/provider_config.json` 全量清单 | `BRIDGE_CONFIG_MODELS` 截断（默认 top:16） |

同 id 先到先得（手动 > 实时 > 配置）。配置层只读模型 id 清单，**绝不读取/外发**文件中的 apiKey。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BRIDGE_PERMISSION_MODE` | `allow` | `allow`=自动切 yolo 全放行；`deny`=保持默认模式且权限请求一律拒。未知值按 deny 并告警 |
| `BRIDGE_ZCODE_BIN` | `zcode` | zcode 可执行名/路径（多实例运行时各自指向） |
| `BRIDGE_ZCODE_HOME` | 继承 | 传给 app-server 的 HOME（借用某实例的配置/登录态）。⚠️ 同时决定 provider_config.json 的解析位置 |
| `BRIDGE_MODELS` | 空 | 手动模型清单 `modelId[@level],...`，如 `kimi-k3@low,cn:glm-5.3-flash@max` |
| `BRIDGE_DEFAULT_MODEL` | 清单首项 | 建会话时默认切到的模型；支持 `provider␟model[@level]` 显式指定 provider |
| `BRIDGE_CONFIG_MODELS` | `top:16` | 配置层截断：`top:N` / `all` / `off`。多 provider 实例建议 `all`（全局截断会挤掉靠后的 provider 组） |
| `BRIDGE_CONFIG_OPTIONS` | `on` | `off` = v0.1 兼容档（见下） |
| `BRIDGE_COMPACT` | `on` | 是否宣告并接管 `/compact` |
| `BRIDGE_THOUGHT_LEVEL` | `on` | 是否暴露思考深度选择器 |
| `BRIDGE_LOG_DIR` | mkdtemp | 日志目录（系统临时目录下 0700；显式指定时权限由操作员负责） |
| `BRIDGE_TURN_WATCHDOG_MS` | 1500000 | turn 收口看门狗（25min） |
| `BRIDGE_IDLE_EXIT_MS` | 600000 | zcode 子进程闲置回收阈值 |

## `/compact` 手动压缩

斜杠菜单宣告 `available_commands_update`；prompt 首文本块命中 `/compact [指令]` 时拦截，转发
zcode `session/compact`（异步 turn），以 `compaction_update` 卡片回报 in_progress/completed/failed。

⚠️ **`/compact` 是保留前缀**：正文以 `/compact` 开头的内容会被本桥拦截而不会作为普通消息发往 zcode。

## 兼容性

- **codeg 0.35.x**：模型/思考深度/模式走 config options（`session/set_config_option`）。
  codeg 的 UI 规则是「有 configOptions 就不渲染 modes 选择器」，桥因此把模式也做成 config option，
  build/plan/yolo 等模式在 codeg 里不会消失。
- **v0.1 宿主（MindFS 等）**：设 `BRIDGE_CONFIG_OPTIONS=off` 一键回退——不发任何 configOptions
  （响应省键而非空数组）、不发 `config_option_update`/`available_commands_update`、`/compact` 不拦截
  （隐含 `BRIDGE_COMPACT=off`）。模型走 `models` 块 + `session/set_model`，模式走 `modes` 块 +
  `session/set_mode`，与 v0.1 完全一致。此时建议 `BRIDGE_CONFIG_MODELS=off`（或 `top:4`），
  避免 models 下拉塞入全量清单。

## 日志与隐私

- 日志写文件（默认系统临时目录 `mkdtemp`，0700/0600），**stderr 保持安静**（部分宿主会据 stderr
  的 `"code"+\"message\"` 形状行取消在飞 prompt）。
- 记录：生命周期事件、zcode stderr、错误摘要——均经 `redact()`（`sk-`/`Bearer`/`api_key`/
  `Authorization` 等形态脱敏 + 单行化）。
- **不记录**：prompt 与回复正文；事件只留元数据（turnNumber/toolCallId/toolName/tokens 等字段名与计数）。

## 规范偏离声明

ACP session-compaction RFD 要求宿主宣告 `clientCapabilities.session.compaction` 后 agent 才可发送
`compaction_update`。codeg 只对 ClaudeCode|Codex 宣告该能力，但其消费路径对任意 agent 的入站帧均解析；
经源码审查，桥对 codeg 始终发送 `compaction_update`（status ∈ `in_progress|completed|failed`，
不使用 `cancelled`）。

## 测试

```bash
npm test        # node --test test/bridge.test.mjs test/murphy.test.mjs
```

45 个用例：协议形状、config option 全链路、/compact 生命周期、以及墨菲定律组
（1MB prompt、同 chunk 竞态、SEP 注入、并发建会话、宿主 stdin 断开、v0.1 兼容档、
already_running 跟随竞态、cancel 重建窗口、spawn 并发闸、close×respawn 孤儿收尸等）。
测试用 mock zcode（`test/mock-zcode-server.mjs`），行为由 `MOCK_*` 环境变量驱动。

## v0.3 健壮性设计要点

- **turn 精确归属（inputId）**：session/send|compact 携带唯一 inputId，zcode 3.14+ 在
  turn.started/completed/failed 中回显；终结事件按 inputId 匹配在飞 op，旧版 zcode
  （无回显）自动退回三重身份判定兜底。
- **already_running 跟随模式**：/compact 撞上在飞压缩时保留 compaction 态补发 in_progress 卡，
  本轮由在飞那轮的终结事件收口（其 inputId 已转 foreignInputIds 追踪，配 followForeign 门控
  防无关僵尸轮误收）。
- **看门狗补刀**：turn/compact 看门狗触发时向 zcode 发 session/stop，防僵尸 turn 占会话
  （后续请求 -32010）。
- **respawn 语义**：恢复宿主显式设置的模式（explicitMode）而非强制 yolo；close 与重建竞态由
  closed 检查兜底（新子进程立即回收）；cancel 落在重建窗口内时本轮直接 cancelled 收口。
- **并发与隔离**：new/load/resume/respawn 全局并发闸（默认 8，超限 -32603）；load/resume 拒绝
  跨 workspace 挂会话；set_config_option 串行 + 积压上限（32）。
- **日志安全**：日志目录 0700、文件 0600（轮转后 chmod 兜底）；redact 覆盖 sk-/Bearer/
  Authorization/api_key/token/AKIA/ghp_/JWT/cookie 等形态；stderr 静默（防宿主误判）。
