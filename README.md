# WorkBuddy Remote Monitor

从微信小程序远程查看并控制电脑端 WorkBuddy 任务的服务端 + 控制台 + 小程序全套代码。

## 功能

- **任务监控**：实时查看 WorkBuddy 全部会话/任务的状态、进度、活跃步骤
- **远程控制**：发消息、暂停、恢复、取消、重试
- **选项回传**：Agent 提出的带选项问题（AskUserQuestion）实时推送到手机，点选后走 `resolveInterruption` 原生填回，与桌面端点选同源
- **本机控制台**：Web 面板管理服务端（启动/停止/重启/重置 Token/日志实时查看）
- **跨平台**：Windows 与 macOS 双支持

## 下载

编译好的自包含分发包（内置 Node 运行时，目标电脑无需装 Node、无需 npm install）见 [Releases](https://github.com/shaliuxin/workbuddy-remote-monitor/releases)：

| 文件 | 平台 |
|---|---|
| `WorkBuddyMonitor-1.2.0.zip` | Windows（内置 Node 22.22.2） |
| `WorkBuddyMonitor-macos-1.2.0.tar.gz` | macOS arm64 + x64（内置 Node 22.22.2） |

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

## 目录结构

```
├── workbuddy-monitor-server.js   # 监控服务端（HTTP + WebSocket + 任务扫描）
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

## 说明

- UI 注入依赖本机 Python（按 `WB_PYTHON` → 包内 `runtime/python.exe` → 系统 PATH 顺序查找），找不到时自动走 steer 协议（纯 ACP），功能等价
- 控制指令依赖读取 WorkBuddy 网关进程的 `CODEBUDDY_GATEWAY_PASSWORD`；macOS 因安全限制可能读不到，此时控制指令返回"网关不可用"，任务监控等核心功能不受影响
