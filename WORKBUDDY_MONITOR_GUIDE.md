# WorkBuddy 任务监控系统 - 完整使用指南

## 系统组成

```
┌──────────────────┐              ┌─────────────────────┐              ┌────────────────┐
│  手机端小程序     │ ◄──────────► │  WorkBuddy 本地服务端 │ ◄──────────► │ ~/.workbuddy/  │
│  (已开发完成)     │   WebSocket  │  127.0.0.1:48787      │   文件监控    │ tasks/         │
│                  │              │                      │              │                │
│ - 实时查看任务    │              │ - 扫描任务 JSON      │              │ - 任务状态      │
│ - 发送控制指令    │              │ - 推送状态变化       │              │ - 执行日志      │
│ - 发送文字消息    │              │ - 处理指令           │              │                │
└──────────────────┘              └─────────────────────┘              └────────────────┘
```

## 快速开始

### 第 1 步：启动服务端（电脑端）

**方法 A：前台运行（开发测试用）**
```bash
cd C:/Users/mingh/WorkBuddy/2026-11-20-21-35-26
node workbuddy-monitor-server.js
```

**方法 B：后台运行（推荐）**
```bash
# 双击运行
start-monitor-server-bg.bat

# 或命令行
.\start-monitor-server-bg.bat
```

**方法 C：手动后台运行**
```bash
# Windows (PowerShell)
Start-Process node -ArgumentList "workbuddy-monitor-server.js" -WindowStyle Hidden

# Linux/Mac
nohup node workbuddy-monitor-server.js > monitor-server.log 2>&1 &
```

启动成功后会看到：
```
========================================
WorkBuddy 任务监控服务端已启动
========================================
HTTP 端点: http://127.0.0.1:48787
WebSocket: ws://127.0.0.1:48787/ws
Token:     e02cc7d9b6c2ffeea1aa5572766aeb4090cc4926d35eb662062664a08a6cf472
========================================
任务目录: C:\Users\mingh\.workbuddy\tasks
========================================
[Init] 发现 23 个任务
[Init] 最新任务: 关窗确认 + 文件导入导出
```

**记录 Token**（用于小程序配置）

### 第 2 步：配置小程序

**当前版本（模拟数据）**

小程序目前使用模拟数据，不会连接真实服务端。如需连接，需修改 `utils/workbuddy-task-client.js` 中的 `connect()` 函数：

```javascript
function connect(options) {
    // 真实实现：建立 WebSocket 连接
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(options.endpoint + '?token=' + options.token);
        
        ws.onopen = () => {
            resolve({
                data: { connected: true },
                error: null
            });
        };
        
        ws.onerror = (err) => {
            resolve({
                data: null,
                error: { code: 'CONNECTION_FAILED', message: '无法连接到服务端' }
            });
        };
    });
}
```

**注意**：微信小程序不直接支持 WebSocket 客户端，需要通过 `wx.connectSocket()` API。真实部署时需要适配。

### 第 3 步：测试服务端

**测试 HTTP 端点：**
```bash
# 获取 Token（无需鉴权）
curl http://127.0.0.1:48787/token

# 获取任务列表（需要 Token）
curl -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:48787/tasks
```

**测试 WebSocket：**
```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:48787/ws?token=<TOKEN>');
ws.on('message', (data) => console.log(JSON.parse(data)));
"
```

### 第 4 步：停止服务端

```bash
# 前台运行：Ctrl + C

# 后台运行（Windows）
stop-monitor-server.bat

# 或手动
taskkill /F /IM node.exe
```

## 小程序与真实服务对接

### 方案 A：直接 WebSocket（需要适配）

微信小程序使用 `wx.connectSocket()` 而非浏览器 `WebSocket`：

```javascript
// utils/workbuddy-task-client.js
function connect(options) {
    return new Promise((resolve, reject) => {
        const task = wx.connectSocket({
            url: options.endpoint + '?token=' + options.token,
            success: () => {
                resolve({
                    data: { connected: true },
                    error: null
                });
            },
            fail: (err) => {
                resolve({
                    data: null,
                    error: { code: 'CONNECTION_FAILED', message: err.errMsg }
                });
            }
        });

        task.onMessage((res) => {
            const msg = JSON.parse(res.data);
            if (msg.type === 'task_update') {
                // 触发订阅回调
            } else if (msg.type === 'command_response') {
                // 处理指令回执
            }
        });
    });
}
```

**限制**：微信小程序只能在以下情况使用 WebSocket：
- 服务器域名已配置（需在小程序后台配置 `ws://127.0.0.1:48787`）
- 本机调试模式（真机无法连接 `127.0.0.1`）

### 方案 B：局域网 IP（真机调试）

将服务端绑定到局域网 IP，手机通过 WiFi 连接：

**1. 修改服务端监听地址**

编辑 `workbuddy-monitor-server.js`：
```javascript
const CONFIG = {
    port: 48787,
    host: '0.0.0.0',  // 改为监听所有接口
    // ...
};
```

**2. 获取电脑局域网 IP**
```bash
# Windows
ipconfig | findstr IPv4

# Linux/Mac
ifconfig | grep inet
```

**3. 小程序配置**
- Endpoint: `ws://192.168.x.x:48787/ws`（替换为实际 IP）
- Token: `<启动服务时显示的 Token>`

**4. 配置小程序合法域名**
- 打开微信开发者工具
- 详情 → 本地设置 → 不校验合法域名（开发阶段）
- 或登录微信公众平台 → 开发 → 开发设置 → 服务器域名 → 添加 `ws://192.168.x.x:48787`

### 方案 C：云端中转（生产环境）

如果需要在公网使用，可以通过云服务器中转：

```
手机小程序 ←→ 云服务器 WebSocket ←→ 电脑本地服务端
```

**优点**：手机可在任何网络使用，不受局域网限制
**缺点**：需要云服务器，增加延迟

## 与 WorkBuddy 集成

当前服务端只模拟了指令处理，真实场景需要与 WorkBuddy 任务引擎集成：

### 集成点 1：任务控制

在 `workbuddy-monitor-server.js` 的 `handleCommand` 函数中：

```javascript
const workbuddyAPI = require('workbuddy-internal-api'); // 假设的 API

case 'pause':
    workbuddyAPI.tasks.pause(taskId);
    response.message = '已暂停任务';
    break;
case 'cancel':
    workbuddyAPI.tasks.cancel(taskId);
    response.message = '已取消任务';
    break;
```

### 集成点 2：消息发送

```javascript
case 'send_message':
    const task = workbuddyAPI.tasks.get(taskId);
    if (task && task.process) {
        task.process.stdin.write(params.message + '\n');
        response.message = '已发送消息';
    } else {
        response.success = false;
        response.message = '任务未运行，无法发送消息';
    }
    break;
```

### 集成点 3：实时推送

监听 WorkBuddy 任务事件，立即推送：

```javascript
workbuddyAPI.events.on('task:status-changed', (taskId, newStatus) => {
    broadcastTasks(wss); // 立即推送，无需等待定时器
});
```

## 故障排查

### 问题：服务端启动失败

**检查端口占用：**
```bash
# Windows
netstat -ano | findstr :48787
tasklist | findstr <PID>

# Linux/Mac
lsof -i :48787
kill -9 <PID>
```

### 问题：小程序连接失败

**检查清单：**
1. 服务端是否已启动？查看控制台或日志文件
2. Token 是否正确？与启动信息对比
3. 手机和电脑是否在同一 WiFi？（局域网方案）
4. 防火墙是否允许 48787 端口？

**Windows 防火墙配置：**
```powershell
# 允许 Node.js 通过防火墙
New-NetFirewallRule -DisplayName "WorkBuddy Monitor" -Direction Inbound -Program "C:\Program Files\nodejs\node.exe" -Action Allow
```

### 问题：任务不更新

**检查：**
1. `~/.workbuddy/tasks/` 目录是否有新文件
2. 任务 JSON 格式是否正确
3. 查看服务端日志：`type monitor-server.log`

## 日志管理

**查看实时日志：**
```bash
# 前台运行时直接看控制台

# 后台运行时查看日志文件
type monitor-server.log
# 或持续跟踪
powershell Get-Content monitor-server.log -Wait -Tail 10
```

**日志位置：**
- 前台：控制台输出
- 后台：`monitor-server.log`（需手动重定向）

## 性能优化

### 优化 1：减少扫描频率

当前每 2 秒扫描一次，如果任务数量很多（>100），可以改为：

```javascript
// 使用 fs.watch 监听文件变化
fs.watch(CONFIG.tasksDir, { recursive: true }, (event, filename) => {
    if (filename && filename.endsWith('.json')) {
        broadcastTasks(wss); // 文件变化时立即推送
    }
});
```

### 优化 2：增量推送

只推送变化的任务，而非全量：

```javascript
function broadcastTasks(wss) {
    const tasks = scanTasks();
    const changed = tasks.filter(t => {
        const cached = taskCache.get(t.id);
        return !cached || cached.status !== t.status || cached.updatedAt !== t.updatedAt;
    });
    
    if (changed.length > 0) {
        // 只推送变化的任务
        changed.forEach(t => taskCache.set(t.id, t));
        // ...
    }
}
```

## 安全建议

1. **生产环境不要使用 `0.0.0.0`**：仅监听 `127.0.0.1`，通过云端中转
2. **定期更换 Token**：删除 `~/.workbuddy/.monitor-token` 重启服务
3. **限制指令权限**：高风险指令（如 `cancel`）需在 WorkBuddy 端确认
4. **日志脱敏**：确保日志不包含敏感信息

## 下一步

1. **测试完整流程**：启动服务端 → 配置小程序 → 验证实时推送
2. **集成到 WorkBuddy**：调用真实的任务引擎 API
3. **部署到生产**：云端中转方案（可选）
4. **用户体验优化**：扫码配置、任务筛选、搜索等功能

---

**技术支持**：如有问题，请查看 `WORKBUDDY_MONITOR_README.md` 或提交 Issue。
