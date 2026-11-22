# WorkBuddy 任务监控小程序 - 架构设计

## 当前状态

小程序已完成双向交互的 UI 和逻辑框架，使用模拟数据展示效果。

## 真实场景架构

### 数据流

```
┌─────────────────┐         WebSocket/HTTP          ┌──────────────────┐
│  手机端小程序    │ ◄──────────────────────────────► │  WorkBuddy 本地   │
│                 │   实时推送任务状态 + 指令         │  服务端（待实现）  │
│ - 展示任务列表   │                                  │                  │
│ - 发送控制指令   │                                  │ - 读取 tasks/    │
└─────────────────┘                                  │ - 推送状态变化    │
                                                     │ - 执行控制指令    │
                                                     └──────────────────┘
                                                              │
                                                              │ 监控
                                                              ▼
                                                     ┌──────────────────┐
                                                     │ ~/.workbuddy/    │
                                                     │ tasks/*.json     │
                                                     └──────────────────┘
```

### WorkBuddy 本地服务端 API（待实现）

#### 1. WebSocket 端点（推荐）
```
ws://localhost:48787/ws
```

**服务端 → 客户端推送：**
```json
{
  "type": "task_update",
  "tasks": [
    {
      "id": "60e9c794-8b21-4797-8d2c-723503d087cf/8",
      "subject": "Privacy manifest + re-deploy",
      "activeForm": "Writing privacy manifest",
      "description": "Write .wbapp_v4aiYkMQe4Q8ElOGITAsjP.privacy.json...",
      "status": "in_progress",
      "createdAt": 1795229240244,
      "updatedAt": 1795274492521
    }
  ]
}
```

**客户端 → 服务端指令：**
```json
{
  "type": "command",
  "taskId": "60e9c794-8b21-4797-8d2c-723503d087cf/8",
  "command": "pause",
  "params": {}
}
```

**支持的指令：**
- `pause`: 暂停任务执行
- `resume`: 恢复暂停的任务
- `cancel`: 取消任务
- `retry`: 重新提交失败的任务

#### 2. HTTP 端点（备选）
```
GET  http://localhost:48787/tasks              # 获取任务列表快照
POST http://localhost:48787/tasks/:id/command  # 发送控制指令
```

### 安全性考虑

1. **仅限本机访问**: 服务端只监听 `127.0.0.1`，不暴露到外网
2. **Token 鉴权**: 首次启动时生成随机 token，手机端需扫码获取
3. **指令确认**: 高风险指令（如 `cancel`）需在 WorkBuddy 端弹窗确认

### 实现方式（WorkBuddy 侧）

#### 选项 A: 内置轻量 HTTP 服务
使用 Node.js `http` 模块或 Express：
```javascript
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const server = http.createServer((req, res) => {
  if (req.url === '/tasks') {
    // 扫描 ~/.workbuddy/tasks/ 目录
    // 返回 JSON 任务列表
  }
});

const wss = new WebSocket.Server({ server, path: '/ws' });

// 监听任务文件变化
// 通过 fs.watch 或轮询 tasks/ 目录
// 变化时向所有 WebSocket 客户端推送更新

server.listen(48787, '127.0.0.1');
```

#### 选项 B: Electron IPC 转发
如果 WorkBuddy 桌面版使用 Electron：
```javascript
// 主进程
const { ipcMain } = require('electron');
const WebSocket = require('ws');

// 创建 WebSocket 服务器
// 通过 IPC 从渲染进程获取任务状态
// 接收控制指令并通过 IPC 转发给任务执行引擎
```

### 手机端配置

1. **获取连接信息**：
   - 首次使用时，在 WorkBuddy 中生成 QR 码
   - 包含：IP 地址、端口、Token
   - 手机端扫码自动配置

2. **动态 endpoint**：
   ```javascript
   // 替换 utils/workbuddy-task-client.js 中的 connect() 函数
   const { data: conn } = await connect({
       endpoint: config.scannedEndpoint, // 从扫码获取
       token: config.scannedToken,
   });
   ```

## 当前模拟实现

- `connect()`: 模拟连接成功
- `subscribeTasks()`: 3 秒推送一次模拟任务列表
- `sendCommand()`: 打印指令并模拟成功
- `fetchTasks()`: 返回 4 条模拟任务

## 下一步

1. **WorkBuddy 端**：实现上述 WebSocket 服务端
2. **手机端**：替换 `connect()` 中的 endpoint 获取逻辑，添加扫码功能
3. **联调测试**：在真机上验证实时推送和指令执行
