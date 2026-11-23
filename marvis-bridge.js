'use strict';
/**
 * Marvis 桥接层：把 Marvis 网关（marvis-gateway.js）与本地数据库（marvis-data.js）
 * 统一成监控服务端可直接消费的任务视图模型，并提供控制入口。
 *
 * 任务 id 使用前缀 `marvis:` 与 WorkBuddy 会话区分。
 */

const marvisData = require('./marvis-data');
const { MarvisGateway } = require('./marvis-gateway');

let gw = null;
let connecting = null;
const recentEvents = []; // 最近推送事件（供服务端轮询/调试）

function ensureConnected(callback) {
    if (gw && gw.ready) return callback(null, gw);
    if (connecting) return connecting.then(g => callback(null, g)).catch(e => callback(e));
    connecting = new Promise((resolve, reject) => {
        const g = new MarvisGateway();
        g.onEvent('*', (event, data) => {
            recentEvents.push({ at: Date.now(), event, data });
            if (recentEvents.length > 200) recentEvents.shift();
        });
        g.connect(err => {
            if (err) { connecting = null; return reject(err); }
            gw = g;
            resolve(g);
        });
    });
    return connecting.then(g => callback(null, g)).catch(e => callback(e));
}

/**
 * 读取 Marvis 任务（来源：SQLite），映射成通用任务模型
 * 返回数组，id 形如 marvis:conv_xxx
 */
function readTasks() {
    let result;
    try { result = marvisData.readMarvisTasks(); }
    catch (e) { return []; }
    const tasks = (result && result.tasks) || [];
    const now = Date.now();
    // 数据层 id 形如 marvis_conv_xxx，统一加 'marvis:' 作为来源前缀
    return tasks.map(t => ({
        id: 'marvis:' + String(t.id || t.conversationId || ''),
        title: t.title || '未命名任务',
        subject: t.subject || t.title || '',
        activeForm: t.activeForm || '',
        description: t.description || '',
        status: t.status || 'pending',
        progress: typeof t.progress === 'number' ? t.progress : (t.status === 'completed' ? 100 : 0),
        step: t.step || '',
        model: t.model || null,
        modelShort: t.modelShort || (t.model ? String(t.model).replace(/^custom-local:/, '').slice(0, 14) : ''),
        createdAt: t.createdAt || now,
        updatedAt: t.updatedAt || now,
        source: 'marvis',
    }));
}

/** 读取会话对话（去掉前缀） */
function readConversation(taskId) {
    const id = String(taskId || '').replace(/^marvis:/, '');
    try { return marvisData.readMarvisConversation(id); }
    catch (e) { return { messages: [], error: e.message }; }
}

/** 调用网关 RPC */
function rpc(event, payload, callback) {
    ensureConnected((err, g) => {
        if (err) return callback(err);
        g.call(event, payload || {}, callback);
    });
}

/** 审批回传：blocking.resolve */
function resolveBlocking(blockingId, decision, input, callback) {
    rpc('blocking.resolve', Object.assign(
        { blocking_id: blockingId, decision: decision },
        input !== undefined ? { input: input } : {}
    ), callback);
}

/** 中止运行中任务：chat.abort（agent 转发，尽力而为） */
function abortConversation(conversationId, callback) {
    rpc('chat.abort', { conversation_id: conversationId }, callback);
}

/** 网关状态 */
function status(callback) {
    ensureConnected((err, g) => {
        callback(null, {
            connected: !err && !!(g && g.ready),
            token: g ? g.token : null,
            recentEvents: recentEvents.slice(-20),
        });
    });
}

module.exports = {
    readTasks,
    readConversation,
    rpc,
    resolveBlocking,
    abortConversation,
    status,
    isMarvisTask: id => String(id || '').startsWith('marvis:'),
};
