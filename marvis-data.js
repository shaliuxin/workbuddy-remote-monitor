'use strict';

/**
 * Marvis 本地数据读取层
 *
 * 数据来源：Marvis 用户目录下的 SQLite（data.db / business.db），只读打开。
 * 输出：与 remote-task-monitor 中 fromWorkBuddyTask() 同形状的任务视图模型，
 * 这样现有小程序卡片、筛选、模型按钮无需改结构即可展示 Marvis 任务。
 *
 * 注意：本模块只读取本地数据库，不修改 Marvis 的任何文件。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const MARVIS_HOME_CANDIDATES = [
    process.env.MARVIS_HOME,
    path.join(os.homedir(), '.marvis'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Tencent', 'Marvis', 'User'),
].filter(Boolean);

/** 找到包含 database/data.db 的 Marvis 用户目录 */
function resolveMarvisHome() {
    const candidates = [];
    for (const item of MARVIS_HOME_CANDIDATES) {
        try {
            const real = fs.realpathSync(item);
            const stat = fs.statSync(real);
            if (stat.isDirectory()) {
                const direct = path.join(real, 'database', 'data.db');
                if (fs.existsSync(direct)) {
                    candidates.push(real);
                } else {
                    // User 根目录：取 data.db 最近修改的用户
                    for (const name of fs.readdirSync(real)) {
                        const p = path.join(real, name, 'database', 'data.db');
                        if (fs.existsSync(p)) {
                            candidates.push({ dir: path.join(real, name), mtime: fs.statSync(p).mtimeMs });
                        }
                    }
                }
            }
        } catch (_) {
            // 路径不存在或不可读，跳过
        }
    }
    // 带 mtime 的候选项按最近修改排序
    const withTime = candidates.filter((c) => c && typeof c === 'object' && c.mtime);
    const dirs = candidates.filter((c) => typeof c === 'string');
    withTime.sort((a, b) => b.mtime - a.mtime);
    return withTime.length ? withTime[0].dir : (dirs[0] || null);
}

function openReadOnly(file) {
    return new DatabaseSync(file, { readOnly: true });
}

function all(db, sql, params = []) {
    try {
        return db.prepare(sql).all(...params);
    } catch (err) {
        console.warn('[Marvis] 查询失败:', err.message, sql.slice(0, 80));
        return [];
    }
}

function parseJson(value, fallback) {
    if (typeof value !== 'string' || value === '') {
        return fallback;
    }
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

function toMillis(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const n = Date.parse(value);
        if (Number.isFinite(n)) {
            return n;
        }
    }
    return Date.now();
}

function statusToView(status) {
    switch (status) {
        case 'created':
        case 'pending':
            return { status: 'pending', statusText: '等待中', statusCls: 'status-pending', progress: 0 };
        case 'running':
        case 'in_progress':
            return { status: 'in_progress', statusText: '进行中', statusCls: 'status-running', progress: 50 };
        case 'completed':
            return { status: 'completed', statusText: '已完成', statusCls: 'status-success', progress: 100 };
        case 'failed':
        case 'cancelled':
            return { status: 'failed', statusText: status === 'cancelled' ? '已取消' : '失败', statusCls: 'status-failed', progress: 100 };
        default:
            return { status: 'pending', statusText: status || '未知', statusCls: 'status-pending', progress: 0 };
    }
}

function shortModelName(model) {
    if (typeof model !== 'string') {
        return '';
    }
    let name = model.trim().replace(/^custom-local:/i, '');
    if (name.length > 14) {
        name = name.slice(0, 13) + '…';
    }
    return name;
}

function clip(text, max) {
    if (typeof text !== 'string') {
        return '';
    }
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

/**
 * 读取 Marvis 任务列表。
 * @returns {{source:string, tasks:Array, selectionRequests:Object, error?:string}}
 */
function readMarvisTasks() {
    const home = resolveMarvisHome();
    if (!home) {
        return { source: 'marvis', tasks: [], selectionRequests: {}, error: '未找到 Marvis 用户数据目录' };
    }

    const dataFile = path.join(home, 'database', 'data.db');
    const businessFile = path.join(home, 'database', 'business.db');
    let dataDb;
    let businessDb;
    try {
        dataDb = openReadOnly(dataFile);
        try {
            businessDb = openReadOnly(businessFile);
        } catch (_) {
            businessDb = null;
        }

        // 模型绑定：conversation_id -> model_ref
        const modelMap = new Map();
        if (businessDb) {
            for (const row of all(businessDb, 'select conversation_id, model_ref from conversation_model_bindings')) {
                modelMap.set(row.conversation_id, row.model_ref);
            }
            // 兜底：从最近的 token 用量推断（llm_token_usage 位于 data.db）
            for (const row of all(dataDb, 'select conversation_id, model_id from llm_token_usage order by created_at desc')) {
                if (row.conversation_id && !modelMap.has(row.conversation_id)) {
                    modelMap.set(row.conversation_id, row.model_id);
                }
            }
        }

        const conversations = all(
            dataDb,
            'select conversation_id, title, status, metadata, created_at, updated_at from conversations order by updated_at desc limit 100'
        );

        const messages = all(
            dataDb,
            'select conversation_id, role, content, metadata, message_seq, tool_name, created_at from messages order by message_seq asc'
        );
        const byConv = new Map();
        for (const msg of messages) {
            if (!byConv.has(msg.conversation_id)) {
                byConv.set(msg.conversation_id, []);
            }
            byConv.get(msg.conversation_id).push(msg);
        }

        // 审批请求：status=pending 的项映射成小程序的选项卡片
        const selectionRequests = {};
        for (const row of all(
            dataDb,
            "select approval_id, conversation_id, tool_name, arguments, reason, metadata from approvals where status = 'pending'"
        )) {
            const args = parseJson(row.arguments, {});
            selectionRequests['marvis_' + row.conversation_id] = {
                requestId: row.approval_id,
                prompt: clip(row.reason || args.reason || args.prompt || `Marvis 请求执行 ${row.tool_name || '操作'}，是否允许？`, 160),
                options: [
                    { value: 'approve', label: '允许' },
                    { value: 'deny', label: '拒绝' },
                ],
            };
        }

        const tasks = conversations.map((conv) => {
            const view = statusToView(conv.status);
            const msgs = byConv.get(conv.conversation_id) || [];
            const userText = (msgs.find((m) => m.role === 'user') || {}).content || '';
            const assistantMsgs = msgs.filter((m) => m.role === 'assistant' && m.content);
            const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
            const lastTool = msgs.filter((m) => m.role === 'tool' && m.tool_name).slice(-1)[0];
            const model = modelMap.get(conv.conversation_id) || '';
            const updatedAt = toMillis(conv.updated_at);

            return {
                id: 'marvis_' + conv.conversation_id,
                title: clip(conv.title || userText || '未命名任务', 80) || '未命名任务',
                stepSubject: lastTool ? clip(lastTool.content, 100) : '',
                activeForm: '',
                description: clip(lastAssistant ? lastAssistant.content : userText, 200),
                status: view.status,
                statusText: view.statusText,
                statusCls: view.statusCls,
                progress: view.progress,
                progressText: view.progress + '%',
                createdAt: toMillis(conv.created_at),
                updatedAt,
                updatedText: formatTime(updatedAt),
                model,
                modelShort: shortModelName(model),
                source: 'marvis',
            };
        });

        return { source: 'marvis', tasks, selectionRequests };
    } catch (err) {
        return { source: 'marvis', tasks: [], selectionRequests: {}, error: err.message };
    } finally {
        if (dataDb) {
            try { dataDb.close(); } catch (_) {}
        }
        if (businessDb) {
            try { businessDb.close(); } catch (_) {}
        }
    }
}

function formatTime(value) {
    const d = new Date(value);
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 读取指定会话的最新对话内容（用于小程序的“对话”面板） */
function readMarvisConversation(taskId) {
    const home = resolveMarvisHome();
    if (!home) {
        return { text: '', error: '未找到 Marvis 用户数据目录' };
    }
    const convId = String(taskId || '').replace(/^marvis_/, '');
    const db = openReadOnly(path.join(home, 'database', 'data.db'));
    try {
        const rows = all(
            db,
            "select role, content, message_seq from messages where conversation_id = ? and role in ('user','assistant') and content is not null and content != '' order by message_seq desc limit 1",
            [convId]
        );
        if (!rows.length) {
            return { text: '', role: '' };
        }
        return { text: clip(rows[0].content, 4000), role: rows[0].role };
    } finally {
        try { db.close(); } catch (_) {}
    }
}

module.exports = {
    resolveMarvisHome,
    readMarvisTasks,
    readMarvisConversation,
};

if (require.main === module) {
    const result = readMarvisTasks();
    console.log(JSON.stringify(result, null, 2));
    if (process.argv[2] === '--conv') {
        // node marvis-data.js --conv marvis_conv_xxx
        console.log(JSON.stringify(readMarvisConversation(process.argv[3] || (result.tasks[0] || {}).id), null, 2));
    }
}
