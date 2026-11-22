/**
 * WorkBuddy 会话 jsonl 回写器
 *
 * 背景：ACP 通用网关（--no-session-persistence）投递的消息，Agent 会真实执行，
 * 结果通过 SSE 返回、更新数据库，但【不写入会话 jsonl】。本模块把 SSE 里的
 * assistant 回复按 WorkBuddy 原生格式追加到目标会话 jsonl，使对话历史可见。
 *
 * jsonl 事实格式（实证 2026-11-22）：
 *   - 每行一个 JSON 对象；消息行 type=message, role=user|assistant
 *   - id 形如 01a20229-441e-7e3e-8f67-cee7621300d2：
 *     去掉横线是 32 位 hex = 时间戳(12 hex=48bit ms) + 随机(20 hex=80bit)
 *   - parentId 指向上一条记录的 id，形成链
 *   - 文本在 content[]：user 用 {type:"input_text",text}, assistant 用 {type:"output_text",text}
 *   - 还有 sessionId / cwd / providerData 等字段
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');

/** 生成 WorkBuddy 风格的 128bit id（时间戳 48bit hex + 随机 80bit hex，8-4-4-4-12 分组） */
function genId(tsMs) {
    const ts = BigInt(tsMs || Date.now()) & 0xffffffffffffn; // 48 bit
    const rand = crypto.randomBytes(10).toString('hex');      // 20 hex = 80 bit
    const hex = ts.toString(16).padStart(12, '0') + rand;      // 32 hex
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
            hex.slice(16, 20), hex.slice(20)].join('-');
}

/**
 * 从 ACP session/prompt 的 SSE 响应体里提取 Agent 的真实回复与元信息。
 * @param {string} sseBody
 * @returns { text, reasoning, conversationRequestId, requestId, traceId, model, modelName, stopReason, userMessageId }
 */
function parseSseReply(sseBody) {
    let text = '';
    let reasoning = '';
    let conversationRequestId = '';
    let requestId = '';
    let traceId = '';
    let model = '';
    let modelName = '';
    let stopReason = '';
    let userMessageId = '';
    for (const line of sseBody.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        let m;
        try { m = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
        // JSON-RPC 最终结果
        if (m.result && typeof m.result === 'object') {
            stopReason = m.result.stopReason || stopReason;
            userMessageId = m.result.userMessageId || userMessageId;
            const meta = m.result._meta || {};
            conversationRequestId = meta['codebuddy.ai/conversationRequestId'] || conversationRequestId;
            requestId = meta['codebuddy.ai/requestId'] || requestId;
            traceId = meta['codebuddy.ai/traceId'] || traceId;
            model = meta['codebuddy.ai/responseModelId'] || model;
            modelName = meta['codebuddy.ai/requestModelName'] || modelName;
            continue;
        }
        const u = m.params && m.params.update;
        if (!u) continue;
        const meta = u._meta || {};
        if (u.sessionUpdate === 'agent_message_chunk' && u.content && typeof u.content.text === 'string') {
            text += u.content.text;
            conversationRequestId = conversationRequestId || meta['codebuddy.ai/conversationRequestId'] || '';
            requestId = requestId || meta['codebuddy.ai/requestId'] || '';
            traceId = traceId || meta['codebuddy.ai/traceId'] || '';
            model = model || meta['codebuddy.ai/responseModelId'] || '';
            modelName = modelName || meta['codebuddy.ai/requestModelName'] || '';
        } else if (u.sessionUpdate === 'agent_thought_chunk' && u.content && typeof u.content.text === 'string') {
            reasoning += u.content.text;
        }
    }
    return { text, reasoning, conversationRequestId, requestId, traceId, model, modelName, stopReason, userMessageId };
}

/** 读取 jsonl 最后一条记录的 id 与 cwd（用于接 parentId、复用真实 cwd） */
function tailMeta(file) {
    let lastId = null;
    let cwd = null;
    let lastTs = Date.now();
    try {
        const data = fs.readFileSync(file, 'utf8');
        const lines = data.split(/\r?\n/);
        for (let i = lines.length - 1; i >= 0; i--) {
            const l = lines[i].trim();
            if (!l) continue;
            let o;
            try { o = JSON.parse(l); } catch (e) { continue; }
            if (!lastId && o.id) lastId = o.id;
            if (!cwd && o.cwd) cwd = o.cwd;
            if (o.timestamp) lastTs = o.timestamp;
            break;
        }
    } catch (e) { /* 文件不存在等 */ }
    return { lastId, cwd, lastTs };
}

/**
 * 把 user 消息 + assistant 回复追加到目标会话 jsonl。
 * @param {string} file 目标 jsonl 绝对路径
 * @param {string} sessionId
 * @param {string} userText 手机发来的原始消息
 * @param {object} reply parseSseReply 的结果
 * @returns { ok, error?, appended? }
 */
function appendExchange(file, sessionId, userText, reply) {
    try {
        if (!fs.existsSync(file)) return { ok: false, error: 'jsonl 不存在: ' + file };
        const tm = tailMeta(file);
        const baseTs = Math.max(Date.now(), (tm.lastTs || 0) + 1);
        const cwd = tm.cwd || '';
        const baggage = 'codebuddy.session_id=' + sessionId +
            (reply.conversationRequestId ? ',codebuddy.conversation_request_id=' + reply.conversationRequestId : '');
        const convReq = reply.conversationRequestId || genId(baseTs).replace(/-/g, '');

        // user 行
        const userId = genId(baseTs);
        const userLine = {
            id: userId,
            timestamp: baseTs,
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: userText }],
            providerData: { agent: 'cli', conversationRequestId: convReq },
            __codebuddyLocal: { sensitiveUserInputReviewed: true },
            sessionId,
            cwd,
            _meta: {
                traceparent: '00-' + (reply.traceId || genId(baseTs).replace(/-/g, '').slice(0, 32)) + '-' + genId(baseTs).replace(/-/g, '').slice(0, 16) + '-01',
                baggage,
            },
        };

        // assistant 行（parentId 指向 user 行）
        const asstId = genId(baseTs + 1);
        const asstLine = {
            id: asstId,
            parentId: userId,
            timestamp: baseTs + 1,
            type: 'message',
            role: 'assistant',
            providerData: {
                conversationRequestId: convReq,
                messageId: (reply.userMessageId || asstId).replace(/-/g, ''),
                traceId: reply.traceId || undefined,
                model: reply.model || 'hy4-flash-free',
                requestModelName: reply.modelName || undefined,
                agent: 'cli',
            },
            status: 'completed',
            content: [{ providerData: { annotations: [] }, type: 'output_text', text: reply.text }],
            sessionId,
            cwd,
            _meta: { baggage, timestamp: new Date(baseTs + 1).toISOString() },
        };
        // 清理 undefined 字段
        Object.keys(asstLine.providerData).forEach(k => {
            if (asstLine.providerData[k] === undefined) delete asstLine.providerData[k];
        });

        const payload = JSON.stringify(userLine) + '\n' + JSON.stringify(asstLine) + '\n';
        fs.appendFileSync(file, payload, 'utf8');
        return { ok: true, appended: 2, userId, asstId, textLen: reply.text.length };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/** 遍历 projects 目录定位 session 的 jsonl（与服务端 findConversationFile 一致） */
function findConversationFile(sessionId, projectsDir) {
    const base = projectsDir || require('path').join(require('os').homedir(), '.workbuddy', 'projects');
    try {
        for (const ws of fs.readdirSync(base)) {
            const f = require('path').join(base, ws, sessionId + '.jsonl');
            if (fs.existsSync(f)) return f;
        }
    } catch (e) { /* ignore */ }
    return null;
}

module.exports = {
    genId,
    parseSseReply,
    tailMeta,
    appendExchange,
    findConversationFile,
};
