// WorkBuddy 任务监控客户端（真实 WebSocket 实现）
//
// 架构：
// 手机小程序 --wx.connectSocket--> WorkBuddy 本地服务端(127.0.0.1:48787)
//                                      |
//                                      +-- 监控 ~/.workbuddy/tasks/
//
// 服务端：workbuddy-monitor-server.js
// 连接信息：启动服务端时控制台会打印 token 和 endpoint

const VALID_STATUSES = ['pending', 'in_progress', 'completed', 'failed'];
const DEFAULT_STATUS = 'pending';
const VALID_COMMANDS = ['pause', 'resume', 'cancel', 'retry', 'send_message', 'select_option', 'select_model'];

// ============================================================
// 全局连接状态（单例）
// ============================================================

const state = {
    socket: null,           // wx.SocketTask
    connected: false,
    endpoint: '',
    token: '',
    connectSeq: 0,          // 连接序列号，防止旧 socket 的迟到回调污染新连接
    taskListeners: [],      // 任务更新监听器
    responseListeners: [],  // 指令回执监听器
    selectionListeners: [], // 选择请求监听器（任务请求用户做选择）
    statusListeners: [],    // 连接状态监听器
    reconnectTimer: null,
    reconnectAttempts: 0,
    manualClose: false,
    pendingCommands: new Map(), // 等待回执的指令（按 taskId+command 匹配）
};

// ============================================================
// 连接管理
// ============================================================

/**
 * 连接到 WorkBuddy 本地服务
 * @param {Object} options - { endpoint, token }
 */
function connect(options) {
    return new Promise((resolve) => {
        const endpoint = (options && options.endpoint) || '';
        const token = (options && options.token) || '';

        if (!endpoint) {
            resolve({
                data: null,
                error: { code: 'INVALID_ENDPOINT', message: '缺少 endpoint' },
            });
            return;
        }

        state.endpoint = endpoint;
        state.token = token;
        state.manualClose = false;

        // 彻底清理旧连接：先摘掉旧 socket 的所有监听器，再关闭，
        // 避免旧 socket 的 onClose/onError 回调污染本次连接。
        const oldSocket = state.socket;
        if (oldSocket) {
            try {
                oldSocket.onOpen(() => {});
                oldSocket.onMessage(() => {});
                oldSocket.onError(() => {});
                oldSocket.onClose(() => {});
                oldSocket.close({ code: 1000 });
            } catch (err) {
                console.error('[Cloud] 清理旧连接失败:', err && err.message);
            }
        }
        state.socket = null;

        // 分配本次连接的唯一序列号，所有回调都用它校验
        const seq = ++state.connectSeq;
        const isCurrent = () => seq === state.connectSeq;

        // 拼接 token 到 URL
        const url = token
            ? endpoint + (endpoint.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token)
            : endpoint;

        console.log('[Cloud] 正在连接 (seq=' + seq + '):', url.replace(/token=[^&]+/, 'token=***'));

        let settled = false;
        const settle = (result) => {
            if (!settled) {
                settled = true;
                resolve(result);
            }
        };

        // 超时保护（8 秒）
        const timer = setTimeout(() => {
            if (!isCurrent()) return;
            settle({
                data: null,
                error: { code: 'TIMEOUT', message: '连接超时，请检查服务端是否启动' },
            });
        }, 8000);

        let socket;
        try {
            socket = wx.connectSocket({ url: url });
        } catch (err) {
            clearTimeout(timer);
            settle({
                data: null,
                error: { code: 'CONNECT_FAILED', message: err && err.message ? err.message : '创建连接失败' },
            });
            return;
        }

        state.socket = socket;

        socket.onOpen(() => {
            if (!isCurrent()) return; // 忽略已被取代的旧连接
            clearTimeout(timer);
            console.log('[Cloud] WebSocket 已连接 (seq=' + seq + ')');
            state.connected = true;
            state.reconnectAttempts = 0;
            notifyStatus('connected', '已连接');
            settle({
                data: { connected: true, endpoint: endpoint },
                error: null,
            });
        });

        socket.onMessage((res) => {
            if (!isCurrent()) return;
            handleServerMessage(res.data);
        });

        socket.onError((err) => {
            clearTimeout(timer);
            console.error('[Cloud] WebSocket 错误 (seq=' + seq + '):', err && err.errMsg);
            // 仅当仍是当前连接时才判定为失败
            if (isCurrent() && !state.connected) {
                state.connected = false;
                notifyStatus('error', '连接错误');
                settle({
                    data: null,
                    error: {
                        code: 'CONNECT_FAILED',
                        message: (err && err.errMsg) || '连接失败',
                    },
                });
            }
        });

        socket.onClose((res) => {
            clearTimeout(timer);
            const code = res && res.code;
            const reason = (res && res.reason) || '';
            console.log('[Cloud] WebSocket 已断开 (seq=' + seq + '), code=' + code + ', reason=' + reason);

            // 已不是当前连接，忽略其回调
            if (!isCurrent()) {
                return;
            }

            state.connected = false;
            state.socket = null;

            // 若尚未 open 就被 close（settled 仍为 false），说明是握手阶段被拒/被平台拦截
            // 常见原因：微信未配置 socket 合法域名、不在开发工具“不校验域名”模式、
            // 服务端 token 校验失败主动 close(1008)
            if (!settled) {
                let message = '连接被关闭';
                if (code === 1008) {
                    message = 'Token 校验失败（1008），请核对 Token 是否与服务端一致';
                } else if (code === 1006 || code === 1005 || code === undefined) {
                    message =
                        '连接被平台或网络中断（' + (code || '无码') + '）。' +
                        '若在真机上：请在微信公众平台配置 socket 合法域名，' +
                        '或改用开发者工具并勾选「不校验合法域名」';
                } else {
                    message = '连接被关闭，code=' + code + (reason ? '，' + reason : '');
                }
                notifyStatus('error', message);
                settle({
                    data: null,
                    error: { code: 'CLOSED_BEFORE_OPEN', message: message },
                });
                return;
            }

            if (!state.manualClose) {
                notifyStatus('disconnected', '连接已断开');
                scheduleReconnect();
            }
        });
    });
}

/**
 * 处理服务端推送的消息
 */
function handleServerMessage(raw) {
    let msg;
    try {
        msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err) {
        console.error('[Cloud] 消息解析失败:', err && err.message);
        return;
    }

    if (!msg || typeof msg !== 'object') {
        return;
    }

    if (msg.type === 'task_update') {
        const tasks = Array.isArray(msg.tasks) ? msg.tasks : [];
        const mapped = tasks.map(fromWorkBuddyTask).filter(Boolean);
        console.log('[Cloud] 收到任务更新:', mapped.length, '个');
        state.taskListeners.forEach((fn) => {
            try {
                fn(mapped);
            } catch (err) {
                console.error('[Cloud] 任务监听器异常:', err && err.message);
            }
        });
        return;
    }

    if (msg.type === 'command_response') {
        console.log('[Cloud] 收到指令回执:', msg.command, msg.success ? 'OK' : 'FAIL', msg.phase || '');

        // 优先路由给等待中的指令
        const key = msg.command + '|' + msg.taskId;
        const pending = state.pendingCommands.get(key);
        if (typeof pending === 'function') {
            pending(msg);
        }

        // 同时通知通用监听器（用于 UI 提示）
        state.responseListeners.forEach((fn) => {
            try {
                fn(msg);
            } catch (err) {
                console.error('[Cloud] 回执监听器异常:', err && err.message);
            }
        });
        return;
    }

    // 异步投递的最终结果（server 端 send_message 完成后推送）
    // 不路由给 pending（已由 accepted 回执 finish），只通知通用监听器用于 UI 提示
    if (msg.type === 'command_result') {
        console.log('[Cloud] 收到投递结果:', msg.command, msg.success ? 'OK' : 'FAIL', msg.message || '');
        state.responseListeners.forEach((fn) => {
            try {
                fn(Object.assign({}, msg, { type: 'command_response' }));
            } catch (err) {
                console.error('[Cloud] 结果监听器异常:', err && err.message);
            }
        });
        return;
    }

    // 任务请求用户做选择（带选项列表）
    if (msg.type === 'selection_request') {
        console.log('[Cloud] 收到选择请求:', msg.prompt, msg.options);
        state.selectionListeners.forEach((fn) => {
            try {
                fn(msg);
            } catch (err) {
                console.error('[Cloud] 选择监听器异常:', err && err.message);
            }
        });
    }
}

/**
 * 断线自动重连（指数退避，最多 5 次）
 */
function scheduleReconnect() {
    if (state.reconnectTimer) {
        return;
    }
    if (state.reconnectAttempts >= 5) {
        console.log('[Cloud] 重连次数已达上限，停止重连');
        notifyStatus('error', '重连失败，请手动刷新');
        return;
    }

    state.reconnectAttempts += 1;
    const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts - 1), 15000);
    console.log('[Cloud] ' + delay + 'ms 后尝试重连（第 ' + state.reconnectAttempts + ' 次）');

    state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        connect({ endpoint: state.endpoint, token: state.token });
    }, delay);
}

function notifyStatus(status, message) {
    state.statusListeners.forEach((fn) => {
        try {
            fn(status, message);
        } catch (err) {
            console.error('[Cloud] 状态监听器异常:', err && err.message);
        }
    });
}

/**
 * 订阅连接状态变化
 * @param {Function} listener - (status, message) => void
 */
function onStatusChange(listener) {
    if (typeof listener !== 'function') {
        return () => {};
    }
    state.statusListeners.push(listener);
    return () => {
        const idx = state.statusListeners.indexOf(listener);
        if (idx !== -1) {
            state.statusListeners.splice(idx, 1);
        }
    };
}

/**
 * 订阅任务列表更新（服务端推送）
 * @param {Function} onUpdate - 回调：tasks => void
 * @returns {Function} unsubscribe
 */
function subscribeTasks(onUpdate) {
    if (typeof onUpdate !== 'function') {
        return () => {};
    }
    state.taskListeners.push(onUpdate);
    return () => {
        const idx = state.taskListeners.indexOf(onUpdate);
        if (idx !== -1) {
            state.taskListeners.splice(idx, 1);
        }
    };
}

/**
 * 订阅指令回执
 * @param {Function} listener - (msg) => void
 */
function onCommandResponse(listener) {
    if (typeof listener !== 'function') {
        return () => {};
    }
    state.responseListeners.push(listener);
    return () => {
        const idx = state.responseListeners.indexOf(listener);
        if (idx !== -1) {
            state.responseListeners.splice(idx, 1);
        }
    };
}

/**
 * 订阅任务的选择请求（任务发来带选项的消息，需用户选择后回传）
 * @param {Function} listener - (msg) => void，msg 含 { requestId, taskId, prompt, options: [{value,label}] }
 * @returns {Function} unsubscribe
 */
function onSelectionRequest(listener) {
    if (typeof listener !== 'function') {
        return () => {};
    }
    state.selectionListeners.push(listener);
    return () => {
        const idx = state.selectionListeners.indexOf(listener);
        if (idx !== -1) {
            state.selectionListeners.splice(idx, 1);
        }
    };
}
function disconnect() {
    state.manualClose = true;
    if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
    }
    if (state.socket) {
        try {
            state.socket.close({ code: 1000 });
        } catch (err) {
            console.error('[Cloud] 关闭连接失败:', err && err.message);
        }
        state.socket = null;
    }
    state.connected = false;
}

// ============================================================
// 指令发送
// ============================================================

/**
 * 发送任务控制指令
 * @param {string} taskId - 任务 ID
 * @param {string} command - pause / resume / cancel / retry / send_message
 * @param {Object} params - 可选参数（send_message 时需 { message: '文本' }）
 * @returns {Promise<{data: Result, error: Object}>}
 */
function sendCommand(taskId, command, params) {
    if (VALID_COMMANDS.indexOf(command) === -1) {
        return Promise.resolve({
            data: null,
            error: { code: 'INVALID_COMMAND', message: '不支持的指令：' + command },
        });
    }

    if (typeof taskId !== 'string' || taskId.trim() === '') {
        return Promise.resolve({
            data: null,
            error: { code: 'INVALID_TASK_ID', message: '任务 ID 不能为空' },
        });
    }

    if (!state.connected || !state.socket) {
        return Promise.resolve({
            data: null,
            error: { code: 'NOT_CONNECTED', message: '尚未连接到服务端' },
        });
    }

    return new Promise((resolve) => {
        const payload = {
            type: 'command',
            taskId: taskId,
            command: command,
            params: params || {},
        };

        // 等待服务端回执（5 秒超时）
        const key = command + '|' + taskId;
        let settled = false;

        const finish = (result) => {
            if (settled) {
                return;
            }
            settled = true;
            if (state.pendingCommands.has(key)) {
                state.pendingCommands.delete(key);
            }
            resolve(result);
        };

        state.pendingCommands.set(key, (msg) => {
            if (msg.success === false) {
                finish({
                    data: null,
                    error: {
                        code: 'COMMAND_REJECTED',
                        message: msg.message || '服务端拒绝了该指令',
                    },
                });
            } else {
                finish({
                    data: {
                        accepted: true,
                        taskId: taskId,
                        command: command,
                        message: msg.message || '',
                        timestamp: Date.now(),
                    },
                    error: null,
                });
            }
        });

        // 超时：服务端会在收到指令后 ~3s 内先回 accepted（phase=accepted），
        // 真正的投递异步进行。放宽到 12s 以容纳弱网/慢设备，避免误报超时。
        setTimeout(() => {
            finish({
                data: null,
                error: { code: 'TIMEOUT', message: '指令发送超时，未收到服务端响应' },
            });
        }, 12000);

        try {
            state.socket.send({
                data: JSON.stringify(payload),
                fail: (err) => {
                    finish({
                        data: null,
                        error: {
                            code: 'SEND_FAILED',
                            message: (err && err.errMsg) || '发送失败',
                        },
                    });
                },
            });
        } catch (err) {
            finish({
                data: null,
                error: {
                    code: 'SEND_FAILED',
                    message: (err && err.message) || '发送异常',
                },
            });
        }
    });
}

/**
 * 获取一次任务列表快照（HTTP）
 * @param {Object} options - { endpoint, token }，省略时用当前连接配置或本地保存的配置
 */
function fetchTasks(options) {
    const saved = loadConfig();
    const endpoint = (options && options.endpoint) || state.endpoint || (saved && saved.endpoint);
    const token = (options && options.token) || state.token || (saved && saved.token) || '';

    if (!endpoint) {
        return Promise.resolve({
            data: null,
            error: { code: 'INVALID_ENDPOINT', message: '缺少 endpoint' },
        });
    }

    // endpoint 形如 ws://host:port/ws，转成 http://host:port
    const httpBase = endpoint
        .replace(/^ws:\/\//, 'http://')
        .replace(/^wss:\/\//, 'https://')
        .replace(/\/ws$/, '');

    return new Promise((resolve) => {
        wx.request({
            url: httpBase + '/tasks',
            method: 'GET',
            timeout: 8000,
            header: token ? { Authorization: 'Bearer ' + token } : {},
            success: (res) => {
                if (res.statusCode === 200 && res.data && Array.isArray(res.data.tasks)) {
                    resolve({
                        data: res.data.tasks.map(fromWorkBuddyTask).filter(Boolean),
                        error: null,
                    });
                } else if (res.statusCode === 401) {
                    resolve({
                        data: null,
                        error: { code: 'UNAUTHORIZED', message: 'Token 无效，请检查配置' },
                    });
                } else {
                    resolve({
                        data: null,
                        error: {
                            code: 'HTTP_ERROR',
                            message: 'HTTP ' + res.statusCode,
                        },
                    });
                }
            },
            fail: (err) => {
                resolve({
                    data: null,
                    error: {
                        code: 'REQUEST_FAILED',
                        message: (err && err.errMsg) || '请求失败',
                    },
                });
            },
        });
    });
}

// ============================================================
// 模型清单获取（HTTP）
// ============================================================

/**
 * 获取服务端的可用模型清单（用于任务模型切换）
 * @param {Object} options - { endpoint, token }，省略则用当前连接配置或本地保存的配置
 * @returns {Promise<{data: Array<{id,name,credits,custom}>|null, error: Object|null}>}
 */
function fetchModels(options) {
    const saved = loadConfig();
    const endpoint = (options && options.endpoint) || state.endpoint || (saved && saved.endpoint);
    const token = (options && options.token) || state.token || (saved && saved.token) || '';

    if (!endpoint) {
        return Promise.resolve({
            data: null,
            error: { code: 'INVALID_ENDPOINT', message: '缺少 endpoint' },
        });
    }

    const httpBase = endpoint
        .replace(/^ws:\/\//, 'http://')
        .replace(/^wss:\/\//, 'https://')
        .replace(/\/ws$/, '');

    return new Promise((resolve) => {
        wx.request({
            url: httpBase + '/models',
            method: 'GET',
            timeout: 8000,
            header: token ? { Authorization: 'Bearer ' + token } : {},
            success: (res) => {
                if (res.statusCode === 200 && res.data && Array.isArray(res.data.models)) {
                    resolve({ data: res.data.models, error: null });
                } else if (res.statusCode === 401) {
                    resolve({ data: null, error: { code: 'UNAUTHORIZED', message: 'Token 无效' } });
                } else {
                    resolve({ data: null, error: { code: 'HTTP_ERROR', message: 'HTTP ' + res.statusCode } });
                }
            },
            fail: (err) => {
                resolve({
                    data: null,
                    error: { code: 'REQUEST_FAILED', message: (err && err.errMsg) || '请求失败' },
                });
            },
        });
    });
}

// ============================================================
// 对话内容获取（HTTP）
// ============================================================

/**
 * 从 HTTP 端点获取某任务最后一条对话内容
 * @param {string} taskId - 任务 ID（形如 <sessionId>/<step>）
 * @param {Object} options - { endpoint, token }，省略则用当前连接配置或本地保存的配置
 * @returns {Promise<{data: {role,text,timestamp,hasMore}|null, error: Object|null}>}
 */
function fetchConversation(taskId, options) {
    const saved = loadConfig();
    const endpoint = (options && options.endpoint) || state.endpoint || (saved && saved.endpoint);
    const token = (options && options.token) || state.token || (saved && saved.token) || '';

    if (!endpoint) {
        return Promise.resolve({
            data: null,
            error: { code: 'INVALID_ENDPOINT', message: '缺少 endpoint' },
        });
    }
    if (typeof taskId !== 'string' || taskId.trim() === '') {
        return Promise.resolve({
            data: null,
            error: { code: 'INVALID_TASK_ID', message: '任务 ID 不能为空' },
        });
    }

    const httpBase = endpoint
        .replace(/^ws:\/\//, 'http://')
        .replace(/^wss:\/\//, 'https://')
        .replace(/\/ws$/, '');

    const url = httpBase + '/conversation?taskId=' + encodeURIComponent(taskId);

    return new Promise((resolve) => {
        wx.request({
            url: url,
            method: 'GET',
            header: token ? { Authorization: 'Bearer ' + token } : {},
            success: (res) => {
                if (res.statusCode === 200 && res.data && typeof res.data.conversation === 'object') {
                    resolve({ data: res.data.conversation, error: null });
                } else if (res.statusCode === 401) {
                    resolve({
                        data: null,
                        error: { code: 'UNAUTHORIZED', message: 'Token 无效，请检查配置' },
                    });
                } else {
                    resolve({
                        data: null,
                        error: { code: 'HTTP_ERROR', message: 'HTTP ' + res.statusCode },
                    });
                }
            },
            fail: (err) => {
                resolve({
                    data: null,
                    error: { code: 'REQUEST_FAILED', message: (err && err.errMsg) || '请求失败' },
                });
            },
        });
    });
}

// ============================================================
// 配置持久化（支持多服务器）
// ============================================================
// 单份配置（当前激活）的存储键，保持向后兼容
const CONFIG_KEY = 'workbuddy-monitor:config';
// 服务器列表的存储键
const SERVERS_KEY = 'workbuddy-monitor:servers';

function loadConfig() {
    try {
        const saved = wx.getStorageSync(CONFIG_KEY);
        if (saved && typeof saved === 'object' && saved.endpoint) {
            return saved;
        }
    } catch (err) {
        console.error('[Cloud] 读取配置失败:', err && err.message);
    }
    return null;
}

function saveConfig(config) {
    try {
        wx.setStorageSync(CONFIG_KEY, config);
    } catch (err) {
        console.error('[Cloud] 保存配置失败:', err && err.message);
    }
}

/**
 * 读取服务器配置列表
 * @returns {Array<{id, name, endpoint, token}>}
 */
function loadServers() {
    try {
        const list = wx.getStorageSync(SERVERS_KEY);
        if (Array.isArray(list) && list.length > 0) {
            return list;
        }
    } catch (err) {
        console.error('[Cloud] 读取服务器列表失败:', err && err.message);
    }
    // 若还没有列表，但有单份激活配置，则迁移成一条**固定 id** 的记录。
    // 注意：必须立即持久化 + 用固定 id —— 旧实现每次生成随机 id 且不落盘，
    // 导致这条"幽灵记录"永远删不掉（删除时按 id 过滤，但源头 CONFIG_KEY 还在，
    // 下次加载又用新 id 重建）。
    const current = loadConfig();
    if (current && current.endpoint) {
        const migrated = {
            id: 'srv_legacy',
            name: deriveServerName(current.endpoint),
            endpoint: current.endpoint,
            token: current.token || '',
        };
        saveServers([migrated]);
        return [migrated];
    }
    return [];
}

/**
 * 覆盖服务器列表
 */
function saveServers(servers) {
    try {
        wx.setStorageSync(SERVERS_KEY, Array.isArray(servers) ? servers : []);
    } catch (err) {
        console.error('[Cloud] 保存服务器列表失败:', err && err.message);
    }
}

/**
 * 保存或更新一个服务器配置
 * @param {Object} server - { id?, name, endpoint, token }
 *   - 传入 id 则更新已有项；不传 id 则新增
 * @returns {Object} 保存后的完整配置（含 id）
 */
function saveServer(server) {
    const list = loadServers();
    const endpoint = (server.endpoint || '').trim();
    const token = server.token || '';
    const name = (server.name || '').trim() || deriveServerName(endpoint);

    let saved;
    if (server.id) {
        const idx = list.findIndex((s) => s.id === server.id);
        if (idx !== -1) {
            list[idx] = { id: server.id, name, endpoint, token };
            saved = list[idx];
        } else {
            saved = { id: server.id, name, endpoint, token };
            list.push(saved);
        }
    } else {
        saved = { id: makeServerId(), name, endpoint, token };
        list.push(saved);
    }
    saveServers(list);
    return saved;
}

/**
 * 删除一个服务器配置
 */
function removeServer(id) {
    const before = loadServers();
    const removed = before.find((s) => s.id === id) || null;
    const list = before.filter((s) => s.id !== id);
    saveServers(list);
    // 同步清理单份激活配置：如果被删的服务器正是当前激活的那台
    // （按 endpoint 匹配，兼容 id 对不上的历史数据），
    // 不清掉的话 loadServers 的迁移分支会把它"复活"。
    const current = loadConfig();
    if (current && removed && current.endpoint === removed.endpoint) {
        clearConfig();
    }
}

/**
 * 设为当前激活并连接
 */
function activateServer(server) {
    const config = { endpoint: server.endpoint, token: server.token || '' };
    saveConfig(config);
    return config;
}

function makeServerId() {
    return 'srv_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
}

/**
 * 从 endpoint 派生一个可读的默认名称
 * 例如 ws://192.168.31.43:48787/ws → 192.168.31.43:48787
 */
function deriveServerName(endpoint) {
    const m = String(endpoint || '').match(/^(?:wss?:\/\/)?([^/?]+)/i);
    return m ? m[1] : String(endpoint || '未命名服务器');
}

function clearConfig() {
    try {
        wx.removeStorageSync(CONFIG_KEY);
    } catch (err) {
        console.error('[Cloud] 清除配置失败:', err && err.message);
    }
}

// ============================================================
// 数据适配器：WorkBuddy 任务 JSON → 小程序视图模型
// ============================================================

function fromWorkBuddyTask(task) {
    if (!task || typeof task !== 'object') {
        return null;
    }

    const status = VALID_STATUSES.indexOf(task.status) !== -1 ? task.status : DEFAULT_STATUS;
    const progress = statusToProgress(status);
    // 服务端可能传时间戳（number）或 ISO 字符串，统一处理
    const created = toMillis(task.createdAt);
    const updated = toMillis(task.updatedAt);

    // title：优先用 WorkBuddy 会话真实任务名（服务端 title 字段）；
    // 没有则回退到当前步骤的 subject。
    const subject = typeof task.subject === 'string' ? task.subject.trim() : '';
    const sessionTitle = typeof task.title === 'string' ? task.title.trim() : '';
    const title = sessionTitle || subject || '未命名任务';

    return {
        id: String(task.id || ''),
        title: title,
        // 当前步骤名（subject），作为副标题，展示任务进展到哪一步
        stepSubject: subject,
        activeForm: typeof task.activeForm === 'string' ? task.activeForm : '',
        description: typeof task.description === 'string' ? task.description : '',
        status: status,
        statusText: statusToText(status),
        statusCls: statusToClass(status),
        progress: progress,
        progressText: progress + '%',
        createdAt: created,
        updatedAt: updated,
        updatedText: formatTime(updated),
        // 来源：marvis = 腾讯 Marvis 任务，其余为 WorkBuddy
        source: typeof task.source === 'string' ? task.source : '',
        isMarvis: String(task.id || '').indexOf('marvis:') === 0 || task.source === 'marvis',
        // 会话当前使用的模型（模型切换功能展示/回显用）
        model: typeof task.model === 'string' ? task.model : '',
        // 卡片按钮上展示的短名，避免长模型名把按钮撑出屏幕
        modelShort: shortModelName(task.model),
    };
}

/**
 * 模型名精简：去掉 provider 前缀并限长，专供任务卡按钮显示。
 * 例：custom-local:qwen3.8:27B → qwen3.8:27B
 */
function shortModelName(model) {
    if (typeof model !== 'string') {
        return '';
    }
    let name = model.trim();
    if (!name) {
        return '';
    }
    name = name.replace(/^custom-local:/i, '');
    if (name.length > 14) {
        name = name.slice(0, 13) + '…';
    }
    return name;
}

function toMillis(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return Date.now();
}

function statusToProgress(status) {
    switch (status) {
        case 'pending': return 0;
        case 'in_progress': return 50;
        case 'completed': return 100;
        case 'failed': return 100;
        default: return 0;
    }
}

function statusToText(status) {
    switch (status) {
        case 'pending': return '等待中';
        case 'in_progress': return '进行中';
        case 'completed': return '已完成';
        case 'failed': return '失败';
        default: return status;
    }
}

function statusToClass(status) {
    switch (status) {
        case 'pending': return 'status-pending';
        case 'in_progress': return 'status-running';
        case 'completed': return 'status-success';
        case 'failed': return 'status-failed';
        default: return 'status-pending';
    }
}

function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '刚刚更新';
    }
    const now = Date.now();
    const diff = now - value;
    if (diff < 60000) {
        return '刚刚';
    }
    if (diff < 3600000) {
        return Math.floor(diff / 60000) + ' 分钟前';
    }
    if (diff < 86400000) {
        return Math.floor(diff / 3600000) + ' 小时前';
    }
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    return month + '-' + day + ' ' + hours + ':' + minutes;
}

function pad(value) {
    return value < 10 ? '0' + String(value) : String(value);
}

/**
 * 把用户输入的服务器地址规范化为完整 WebSocket 地址。
 * 用户只需填 IP（如 192.168.1.5），其余前缀/端口/后缀自动补齐。
 * 同时兼容用户粘贴完整地址的情况。
 * 规则：
 *   - 纯 IP / 域名 / host:port        -> ws://host:48787/ws
 *   - http(s)://host[:port][/...]     -> ws(s)://host[:48787]/ws
 *   - ws(s)://host[:port][/...]       -> ws(s)://host[:48787]/ws
 *   - 已带正确端口和 /ws 后缀的保持原样
 * @param {string} raw 用户输入
 * @returns {{endpoint: string, error: string}} 规范化结果
 */
function normalizeEndpoint(raw) {
    let s = String(raw || '').trim();
    if (!s) return { endpoint: '', error: '请输入服务器 IP 地址' };

    // 去掉首尾空白和结尾斜杠
    s = s.replace(/\s+/g, '');

    let scheme = 'ws';
    let rest = s;

    // 解析协议前缀
    const schemeMatch = s.match(/^(wss|ws|https|http):\/\/(.*)$/i);
    if (schemeMatch) {
        const p = schemeMatch[1].toLowerCase();
        scheme = (p === 'wss' || p === 'https') ? 'wss' : 'ws';
        rest = schemeMatch[2];
    }

    // 去掉路径部分（/ws 或其它），只留 host[:port]
    rest = rest.split('/')[0];

    // 处理 IPv6 方括号地址
    let host = rest;
    let port = '';
    if (rest.startsWith('[')) {
        const m = rest.match(/^\[([^\]]+)\](?::(\d+))?$/);
        if (m) {
            host = '[' + m[1] + ']';
            port = m[2] || '';
        }
    } else {
        const m = rest.match(/^([^:]+)(?::(\d+))?$/);
        if (m) {
            host = m[1];
            port = m[2] || '';
        }
    }

    if (!host) return { endpoint: '', error: '服务器地址格式不正确' };

    // IPv4 合法性校验（纯数字点分形式）
    if (/^[\d.]+$/.test(host)) {
        const parts = host.split('.');
        if (parts.length !== 4 || parts.some((x) => x === '' || Number(x) > 255 || !/^\d+$/.test(x))) {
            return { endpoint: '', error: 'IP 地址格式不正确' };
        }
    }

    // 用户未指定端口时：ws 明文补 48787；wss 则交给反代/域名走默认 443，不强行加端口
    const finalPort = port || (scheme === 'ws' ? '48787' : '');
    const hostPart = finalPort ? host + ':' + finalPort : host;
    const endpoint = scheme + '://' + hostPart + '/ws';
    return { endpoint, error: '' };
}

/**
 * 从 WebSocket 地址里取出 http(s) 基地址，用于 HTTP 探活。
 *   ws://1.2.3.4:48787/ws  -> http://1.2.3.4:48787
 *   wss://a.com/ws         -> https://a.com
 * @param {string} endpoint
 * @returns {string} 基地址；解析失败返回空串
 */
function toHttpBase(endpoint) {
    const s = String(endpoint || '').trim();
    if (!s) return '';
    const converted = s.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
    const m = converted.match(/^(https?:\/\/[^/?#]+)/i);
    return m ? m[1] : '';
}

/**
 * 只显示 host:port，便于用户核对实际连接的地址（不含 token）。
 * @param {string} endpoint
 * @returns {string}
 */
function describeEndpointHost(endpoint) {
    const base = toHttpBase(endpoint);
    return base ? base.replace(/^https?:\/\//i, '') : '';
}

/**
 * 用微信自己的网络栈访问同地址的 /status，判断「网络是否可达」。
 * 这是区分「链路不通」与「WebSocket 被平台拦截」的关键探针：
 *   - WS 超时 + HTTP 探活成功  => 网络通，问题在 WebSocket 协议/握手
 *   - WS 超时 + HTTP 探活失败  => 微信的流量根本没到电脑（VPN 分流、防火墙、不在同一网络）
 * @param {string} endpoint WebSocket 地址
 * @param {string} token 访问令牌
 * @param {number} [timeoutMs=4000]
 * @returns {Promise<{ok: boolean, statusCode?: number, blocked?: boolean, message?: string}>}
 */
function probeHttpEndpoint(endpoint, token, timeoutMs) {
    return new Promise((resolve) => {
        const base = toHttpBase(endpoint);
        if (!base) {
            resolve({ ok: false, message: '地址无法解析' });
            return;
        }
        const header = {};
        if (token) header.Authorization = 'Bearer ' + token;
        wx.request({
            url: base + '/status',
            method: 'GET',
            timeout: timeoutMs || 4000,
            header: header,
            success: (res) => {
                resolve({ ok: true, statusCode: res && res.statusCode });
            },
            fail: (err) => {
                const msg = (err && err.errMsg) || '请求失败';
                // 微信域名策略拦截（未开调试 / 未配置合法域名）
                const blocked = msg.indexOf('domain list') !== -1
                    || msg.indexOf('not in domain') !== -1;
                resolve({ ok: false, blocked: blocked, message: msg });
            },
        });
    });
}

module.exports = {
    normalizeEndpoint,
    toHttpBase,
    describeEndpointHost,
    probeHttpEndpoint,
    connect,
    disconnect,
    subscribeTasks,
    onCommandResponse,
    onStatusChange,
    sendCommand,
    fetchTasks,
    fetchModels,
    fetchConversation,
    fromWorkBuddyTask,
    loadConfig,
    saveConfig,
    clearConfig,
    loadServers,
    saveServers,
    saveServer,
    removeServer,
    activateServer,
    VALID_COMMANDS,
    onSelectionRequest,
    isConnected: () => state.connected,
};
