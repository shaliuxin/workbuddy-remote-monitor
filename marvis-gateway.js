'use strict';
/**
 * Marvis 本地网关客户端（反向工程自 Xiaobao Gateway 1.60.x）
 *
 * 网关：127.0.0.1:10123，WebSocket-only（HTTP 仅 /health）。
 * 认证：URL 参数 ?token=<gatewayToken>。
 * token 由 Marvis 前端经 JSB AiStarter.GetGatewayToken 获取，每次重启更换；
 * 本模块从 Marvis 日志（Marvis.log）自动提取最新 token。
 *
 * WS 消息协议：
 *   请求 { event, payload, requestId }
 *   响应 { event, requestId, type:'ack', data:{ ok, action, data/error } }
 *   推送 { event:'gateway.message_new' | 'gateway.message_changed' | ..., type:'event', data }
 * 注意：参数字段名必须是 payload（不是 data/params）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// 可选依赖：优先项目内置 ws，其次全局
function loadWS() {
    for (const p of ['ws', path.join(__dirname, 'node_modules', 'ws')]) {
        try { return require(p); } catch (_) {}
    }
    return null;
}

const GATEWAY_PORT = 10123;
const LOG_CANDIDATES = [
    path.join(os.tmpdir(), 'Tencent', 'Marvis', 'logs', 'Marvis.log'),
    path.join(process.env.APPDATA || '', 'Roaming', 'marvis', 'logs', 'main.log'),
];

/** 从 Marvis 日志提取全部历史 gateway token（最后一个未必是当前有效） */
function extractTokens() {
    const tokens = [];
    for (const file of LOG_CANDIDATES) {
        try {
            if (!fs.existsSync(file)) continue;
            const text = fs.readFileSync(file, 'utf8');
            // 日志中 data 为转义 JSON：\"token\":\"xxxx\"
            const re = /\\?"token\\?"\s*:\s*\\?"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\?"/g;
            let m;
            while ((m = re.exec(text))) if (!tokens.includes(m[1])) tokens.push(m[1]);
        } catch (_) {}
    }
    return tokens;
}

/** 探测当前有效 token：对每个候选调用 HTTP /health?token=xxx，返回 200 的 */
function findActiveToken(tokens, callback) {
    const http = require('http');
    const list = tokens.slice().reverse(); // 最新优先
    let idx = 0;
    const next = () => {
        if (idx >= list.length) return callback(null, null);
        const token = list[idx++];
        const req = http.get({
            host: '127.0.0.1', port: GATEWAY_PORT,
            path: '/health?token=' + token, timeout: 1500,
        }, res => {
            let body = '';
            res.on('data', d => { body += d; });
            res.on('end', () => {
                if (res.statusCode === 200 && body.includes('"code":0')) return callback(null, token);
                next();
            });
        });
        req.on('error', next);
        req.on('timeout', () => { req.destroy(); next(); });
    };
    next();
}

/**
 * MarvisGateway 类
 * 用法：
 *   const gw = new MarvisGateway();
 *   gw.connect(err => { ... });
 *   gw.call('conversations.list', {}, (err, data) => ...);
 *   gw.onEvent('gateway.message_new', payload => ...);
 */
class MarvisGateway {
    constructor(options) {
        options = options || {};
        this.port = options.port || GATEWAY_PORT;
        this.token = options.token || null;
        this.ws = null;
        this.ready = false;
        this.pending = new Map(); // requestId -> {callback, timer}
        this.eventHandlers = new Map();
        this.seq = 0;
        this.reconnectTimer = null;
        this.closedByUser = false;
    }

    onEvent(event, handler) {
        if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, []);
        this.eventHandlers.get(event).push(handler);
    }

    _emit(event, payload) {
        const hs = this.eventHandlers.get(event) || [];
        for (const h of hs) { try { h(payload); } catch (_) {} }
        const any = this.eventHandlers.get('*') || [];
        for (const h of any) { try { h(event, payload); } catch (_) {} }
    }

    _resolveToken(callback) {
        if (this.token) return callback(null, this.token);
        const tokens = extractTokens();
        if (!tokens.length) return callback(new Error('未找到 Marvis gateway token（Marvis 是否运行？）'));
        findActiveToken(tokens, (err, token) => {
            if (err) return callback(err);
            if (!token) return callback(new Error('所有历史 token 均认证失败，请重启 Marvis 后重试'));
            this.token = token;
            callback(null, token);
        });
    }

    connect(callback) {
        const WS = loadWS();
        if (!WS) return callback && callback(new Error('缺少 ws 模块，请先 npm install ws'));
        this._resolveToken((err, token) => {
            if (err) return callback && callback(err);
            const url = `ws://127.0.0.1:${this.port}/?token=${encodeURIComponent(token)}`;
            let ws;
            try { ws = new WS(url); } catch (e) { return callback && callback(e); }
            this.ws = ws;
            let settled = false;
            ws.on('open', () => {});
            ws.on('message', raw => {
                let msg;
                try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
                if (msg.type === 'event') {
                    if (msg.event === 'gateway.connected') {
                        this.ready = true;
                        if (!settled) { settled = true; callback && callback(null, this); }
                    }
                    this._emit(msg.event, msg.data);
                    return;
                }
                if (msg.requestId && this.pending.has(msg.requestId)) {
                    const p = this.pending.get(msg.requestId);
                    this.pending.delete(msg.requestId);
                    clearTimeout(p.timer);
                    const d = msg.data || {};
                    if (d.ok === false || d.error) {
                        p.callback(d.error || new Error('RPC failed'), null);
                    } else {
                        p.callback(null, d.data !== undefined ? d.data : d);
                    }
                }
            });
            ws.on('error', e => {
                if (!settled) { settled = true; callback && callback(e); }
                this._emit('error', { message: String(e && e.message || e) });
            });
            ws.on('close', () => {
                this.ready = false;
                this._emit('disconnected', {});
                if (!this.closedByUser && !this.reconnectTimer) {
                    this.reconnectTimer = setTimeout(() => {
                        this.reconnectTimer = null;
                        this.connect(() => {});
                    }, 5000);
                }
            });
        });
    }

    /** 发起 RPC 调用；callback(err, data) */
    call(event, payload, callback) {
        if (!this.ws || !this.ready) return callback && callback(new Error('网关未连接'));
        const requestId = 'm' + (++this.seq) + '_' + Date.now().toString(36);
        const timer = setTimeout(() => {
            this.pending.delete(requestId);
            callback && callback(new Error('RPC 超时: ' + event), null);
        }, 10000);
        this.pending.set(requestId, { callback: callback || (() => {}), timer });
        try {
            this.ws.send(JSON.stringify({ event, payload: payload || {}, requestId }));
        } catch (e) {
            clearTimeout(timer);
            this.pending.delete(requestId);
            callback && callback(e, null);
        }
    }

    callPromise(event, payload) {
        return new Promise((resolve, reject) => {
            this.call(event, payload, (err, data) => err ? reject(err) : resolve(data));
        });
    }

    close() {
        this.closedByUser = true;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (this.ws) { try { this.ws.close(); } catch (_) {} }
    }

    // ---- 常用便捷方法 ----
    listConversations(cb) { return this.call('conversations.list', {}, cb); }
    getConversation(id, cb) { return this.call('conversations.get', { conversation_id: id }, cb); }
    batchTaskStatus(ids, cb) { return this.call('tasks.batch_status', { task_ids: ids }, cb); }
    resolveBlocking(blockingId, decision, input, cb) {
        const payload = { blocking_id: blockingId, decision };
        if (input !== undefined) payload.input = input;
        return this.call('blocking.resolve', payload, cb);
    }
    approveToolCall(toolCallId, decision, cb) {
        return this.call('tool_calls.approve', { tool_call_id: toolCallId, decision }, cb);
    }
    sendChat(conversationId, text, cb) {
        return this.call('chat.send', { conversation_id: conversationId, text }, cb);
    }
    abortChat(conversationId, cb) {
        return this.call('chat.abort', { conversation_id: conversationId }, cb);
    }
    getProduct(cb) { return this.call('product.get', {}, cb); }
    getPersona(cb) { return this.call('persona.get', {}, cb); }
}

module.exports = {
    MarvisGateway,
    extractTokens,
    findActiveToken,
    GATEWAY_PORT,
};

if (require.main === module) {
    const gw = new MarvisGateway();
    gw.connect((err) => {
        if (err) { console.error('CONNECT ERROR', err.message); process.exit(1); }
        console.log('CONNECTED token=' + gw.token);
        gw.listConversations((e, d) => {
            console.log('conversations:', JSON.stringify(d, null, 2).slice(0, 1200));
            gw.close();
        });
    });
}
