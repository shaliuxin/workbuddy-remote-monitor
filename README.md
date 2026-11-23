# 远程AI任务管家

从微信小程序远程查看并控制电脑端 WorkBuddy 与腾讯 Marvis 任务的服务端 + 控制台 + 小程序全套代码。

> 显示名称与小程序保持一致为「远程AI任务管家」；仓库地址 `shaliuxin/workbuddy-remote-monitor` 保持不变，以免已有分享链接失效。

## 功能

- **任务监控**：实时查看 WorkBuddy 全部会话/任务的状态、进度、活跃步骤
- **远程控制**：发消息、暂停、恢复、取消、重试
- **选项回传**：Agent 提出的带选项问题（AskUserQuestion）实时推送到手机，点选后走 `resolveInterruption` 原生填回，与桌面端点选同源
- **按任务切模型**：在手机上为单个 WorkBuddy 任务切换模型
- **腾讯 Marvis 支持**：把 Marvis 会话映射成同形任务卡（紫色 `Marvis` 徽章），支持阻塞问题选项回传与工具调用审批；发消息/中止/切模型官方网关未开放，界面会如实提示（详见下文）
- **轻量刷新**：已连接时只拉一次 `/tasks` 快照，不断线重连，避免刷新卡死
- **本机控制台**：Web 面板管理服务端（启动/停止/重启/重置 Token/日志实时查看）
- **跨平台**：Windows 与 macOS 双支持

## 下载

编译好的自包含分发包（内置 Node 运行时，目标电脑无需装 Node、无需 npm install）见 [Releases](https://github.com/shaliuxin/workbuddy-remote-monitor/releases)：

| 文件 | 平台 |
|---|---|
| `WorkBuddyMonitor-1.2.2.zip` | Windows（内置 Node 22.22.2） |
| `WorkBuddyMonitor-macos-1.2.2.tar.gz` | macOS arm64 + x64（内置 Node 22.22.2） |

## 快速上手

1. 解压分发包
2. 运行启动脚本：
   - Windows：双击 `start-console.bat`（脚本为 GBK 编码，cmd 原生兼容）
   - macOS：终端执行 `bash start-console.sh`（按 `uname -m` 自动选架构）
3. 浏览器自动打开控制台 `http://127.0.0.1:48790`，点「启动」拉起监控服务端（监听 `0.0.0.0:48787`）
4. 小程序里填 `ws://<电脑局域网IP>:48787/ws` + 控制台显示的 Token

## 端口

| 用途 | 端口 | 监听范围 |
|---|---|---|
| 监控服务端 | 48787 | 0.0.0.0（手机可访问） |
| 控制台面板 | 48790 | 127.0.0.1（被占用自动顺延 48791~48795） |
| Marvis 网关（本机） | 10123 | 127.0.0.1（由 Marvis 自身提供） |

## 腾讯 Marvis 支持

服务端会自动发现本机 Marvis 会话并合并进任务列表（任务 ID 前缀 `marvis:`），小程序中显示为紫色 `Marvis` 徽章。服务端提供 `GET /marvis/status` 查看网关连接状态。

**数据来源（只读）**

- `AppData\Roaming\Tencent\Marvis\User\<openid>\database\data.db`：会话、消息、阻塞问题、工具调用、事件
- `AppData\Roaming\Tencent\Marvis\User\<openid>\database\business.db`：会话模型绑定
- 使用 Node 22 内置 `node:sqlite` 以只读方式打开，不会修改 Marvis 数据

**网关控制（Xiaobao Gateway）**

- 地址：`ws://127.0.0.1:10123/?token=<gatewayToken>`
- token 由 `marvis-gateway.js` 自动从 `%TEMP%\Tencent\Marvis\logs\Marvis.log` 提取，并通过 `GET /health?token=...` 探测当前有效值；Marvis 每次重启后 token 会变，服务端会自动重新探测，无需手工复制
- 请求格式 `{ event, payload, requestId }`；响应 `{ event, requestId, type: 'ack', data: { ... } }`
- 注意认证参数名是 `token`，Marvis 日志错误提示里的 `url_token` 具有误导性

**能力边界（当前 Marvis 版本）**

| 能力 | 状态 | 说明 |
|---|---|---|
| 查看会话/任务/消息 | 支持 | 合并进 `/tasks`，显示模型、状态与最后一条结论 |
| 阻塞问题选项回传 | 支持 | `blocking.resolve`，手机点选后回填 |
| 工具调用审批 | 支持 | `tool_calls.approve` |
| 发送消息 | 不支持 | 官方网关未开放 `chat.send`，服务端与界面均如实提示 |
| 中止任务 | 不支持 | 官方网关未开放 `chat.abort`，不再伪装成已发送 |
| 切换模型 | 不支持 | `gateway.supports` 返回 `set_model:false`，小程序隐藏该按钮 |

不支持的操作不会伪装成功：服务端返回明确的提示文案，小程序对 Marvis 任务隐藏发送消息框与模型按钮，只保留真正可用的操作。

## 目录结构

```
├── workbuddy-monitor-server.js   # 监控服务端（HTTP + WebSocket + 任务扫描 + 命令分发）
├── marvis-data.js                # 腾讯 Marvis 本地 SQLite 只读读取层
├── marvis-gateway.js             # Marvis 网关 WebSocket 客户端（自动提取/探测 token）
├── marvis-bridge.js              # Marvis 数据与网关控制统一桥接进服务端
├── wb-console-server.js          # 本机控制台后端
├── wb-console.html               # 控制台前端页面
├── wb_acp_bridge.js              # WorkBuddy ACP 网关桥接（session/steer 等）
├── wb_control.js                 # 控制指令分发（steer/原生答题/回写 jsonl）
├── wb_question_watcher.js        # 真实 AskUserQuestion 监听与推送
├── wb_session_activity.js        # 会话活跃度检测（跨平台进程发现）
├── wb_jsonl_writer.js            # ACP 执行结果回写会话 jsonl
├── wb_inject.py                  # Windows UI 注入（可选，缺失时自动降级 steer）
├── build-package.js              # 分发包构建脚本（--mac 构建 macOS 包）
├── remote-task-monitor/          # 微信小程序端源码
└── .workbuddy/_readenv.py 等     # Windows 进程环境读取辅助脚本
```

## 从源码构建分发包

```bash
node build-package.js        # Windows 包
node build-package.js --mac  # macOS 包（下载双架构 Node）
```

打包脚本已把 `marvis-*.js` 纳入文件清单；macOS 构建会复用已有包里的 Node 运行时缓存，避免重复下载。

## 说明

- UI 注入依赖本机 Python（按 `WB_PYTHON` → 包内 `runtime/python.exe` → 系统 PATH 顺序查找），找不到时自动走 steer 协议（纯 ACP），功能等价
- 控制指令依赖读取 WorkBuddy 网关进程的 `CODEBUDDY_GATEWAY_PASSWORD`；macOS 因安全限制可能读不到，此时控制指令返回"网关不可用"，任务监控等核心功能不受影响
- Marvis 相关功能需要本机 Marvis 正在运行；网关 token 每次重启都会变化，服务端会自动重新探测
