const {
    connect,
    disconnect,
    subscribeTasks,
    sendCommand,
    fetchTasks,
    fetchModels,
    fetchConversation,
    loadConfig,
    saveConfig,
    clearConfig,
    loadServers,
    saveServer,
    removeServer,
    activateServer,
    onCommandResponse,
    VALID_COMMANDS,
} = require('../../utils/workbuddy-task-client');

Page({
    data: {
        title: 'WorkBuddy 任务监控',
        subtitle: '实时监控与操作本地任务',

        // 连接状态：connecting | connected | disconnected | error | unconfigured
        connectionState: 'connecting',
        connectionMessage: '正在连接 WorkBuddy...',
        hasConfig: false,
        refreshing: false,

        // 任务列表
        tasks: [],          // 全量任务（服务端推送的原始视图模型）
        visibleTasks: [],   // 经筛选后实际渲染的任务
        summary: { total: 0, pending: 0, running: 0, success: 0, failed: 0 },

        // 筛选条件
        // statusFilter: all | pending | in_progress | completed | failed
        statusFilter: 'all',
        keyword: '',
        filteredCount: 0,

        // 视图状态：loading | ready | empty | filtered-empty | error
        viewState: 'loading',
        errorMessage: '',

        // 指令面板
        commandPanelOpen: false,
        selectedTaskId: '',
        selectedTaskTitle: '',
        availableCommands: [],
        commandButtons: [],
        sendingCommand: false,
        commandResult: '',

        // 对话内容面板（查看任务最后一条对话）
        convPanelOpen: false,
        convLoading: false,
        convRole: '',          // 'assistant' | 'user' | ''
        convText: '',          // 对话文本
        convHasMore: false,    // 文本是否被截断
        convTime: '',          // 格式化时间
        convError: '',         // 加载失败的错误信息

        // 模型选择面板（每个任务切换所用模型）
        modelPanelOpen: false,
        modelPanelTaskId: '',
        modelPanelTaskTitle: '',
        modelPanelCurrent: '',   // 该任务当前模型
        models: [],              // 服务端可用模型清单
        modelsLoading: false,
        modelsError: '',
        modelKeyword: '',        // 模型筛选关键字
        visibleModels: [],       // 筛选后的模型
        switchingModel: false,

        // 服务器列表
        servers: [],
        activeServerId: '',
        serverPanelOpen: false,
        // 正在编辑/新增的服务器表单（null 表示未在编辑）
        editingServer: null,

        // 文字输入
        textMessage: '',

        // 待用户选择的选择请求（按 taskId 存）
        // selectionRequests[taskId] = { requestId, prompt, options: [{value,label}] }
        selectionRequests: {},
    },

    onLoad() {
        // 监听异步投递的最终结果（server 端 send_message 完成后推送 command_result）
        this.offCommandResult = onCommandResponse((msg) => {
            if (msg.command === 'send_message' && msg.message) {
                this.setData({ commandResult: msg.message });
            }
            // 模型切换的最终结果：toast 提示 + 关闭面板 + 刷新任务（服务端会推送新 model 字段）
            if (msg.command === 'select_model') {
                wx.showToast({
                    title: (msg.message || '').slice(0, 40) || (msg.success ? '切换成功' : '切换失败'),
                    icon: 'none',
                    duration: 3000,
                });
                if (msg.success) {
                    this.setData({ modelPanelOpen: false });
                    this.fetchInitialTasks && this.fetchInitialTasks();
                }
            }
        });
        this.bootstrap();
    },

    onUnload() {
        if (this.unsubscribe) {
            this.unsubscribe();
        }
        if (this.offStatus) {
            this.offStatus();
        }
        if (this.offSelection) {
            this.offSelection();
        }
        if (this.offCommandResult) {
            this.offCommandResult();
        }
    },

    async bootstrap() {
        const config = loadConfig();
        if (!config || !config.endpoint) {
            this.setData({
                connectionState: 'unconfigured',
                connectionMessage: '尚未配置连接信息',
                hasConfig: false,
                viewState: 'loading',
            });
            return;
        }
        this.setData({ hasConfig: true });
        await this.connectToWorkBuddy(config);
    },

    async connectToWorkBuddy(config) {
        this.setData({
            connectionState: 'connecting',
            connectionMessage: '正在连接 WorkBuddy...',
            viewState: 'loading',
        });

        const { data: conn, error } = await connect({
            endpoint: config.endpoint,
            token: config.token || '',
        });

        if (error || !conn || !conn.connected) {
            this.setData({
                connectionState: 'error',
                connectionMessage: '无法连接到 WorkBuddy 本地服务',
                viewState: 'error',
                errorMessage: describeConnectError(error, config),
            });
            return;
        }

        this.setData({
            connectionState: 'connected',
            connectionMessage: '已连接',
        });

        // 订阅实时推送
        this.unsubscribe = subscribeTasks((tasks) => {
            this.updateTasksOnly(tasks);
        });

        // 订阅任务发来的选择请求（带选项的消息）
        if (!this.offSelection) {
            this.offSelection = require('../../utils/workbuddy-task-client').onSelectionRequest((msg) => {
                this.handleSelectionRequest(msg);
            });
        }

        // 监听连接断开/重连
        if (!this.offStatus) {
            this.offStatus = require('../../utils/workbuddy-task-client').onStatusChange((status, message) => {
                if (status === 'connected') {
                    this.setData({ connectionState: 'connected', connectionMessage: '已连接' });
                    this.fetchInitialTasks();
                } else if (status === 'error') {
                    this.setData({
                        connectionState: 'error',
                        connectionMessage: message || '连接异常',
                    });
                }
            });
        }

        await this.fetchInitialTasks();
    },

    async fetchInitialTasks() {
        const { data, error } = await fetchTasks();
        if (error) {
            this.setData({
                viewState: 'error',
                errorMessage: error.message || '加载失败',
            });
            return;
        }
        this.updateTasksOnly(data);
    },

    updateTasksOnly(tasks) {
        const source = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
        const nextSummary = computeSummary(source);

        // 如果指令面板已打开，不更新任务列表本身（避免打断用户操作），
        // 但顶部统计仍要刷新，否则数字会停在旧值。
        if (this.data.commandPanelOpen) {
            console.log('[updateTasksOnly] 指令面板已打开，仅更新统计');
            this.setData({ summary: nextSummary, tasks: source });
            return;
        }

        // 脏检查：如果原始数据没变，不触发列表重渲染
        const currentJson = JSON.stringify(this.data.tasks);
        const newJson = JSON.stringify(source);
        if (currentJson === newJson) {
            console.log('[updateTasksOnly] 数据未变化，跳过更新');
            return;
        }

        console.log('[updateTasksOnly] 数据已变化，更新视图');
        this.setData({
            tasks: source,
            summary: nextSummary,
        });
        this.applyFilter();
    },

    /**
     * 按当前筛选条件（状态 + 关键词）计算可见任务并更新视图
     * 任何筛选条件变化、或底层数据更新后都应调用
     */
    applyFilter() {
        const all = this.data.tasks || [];
        const statusFilter = this.data.statusFilter || 'all';
        const keyword = (this.data.keyword || '').trim().toLowerCase();

        const visible = all.filter((task) => {
            if (statusFilter !== 'all' && task.status !== statusFilter) {
                return false;
            }
            if (keyword === '') {
                return true;
            }
            const title = (task.title || '').toLowerCase();
            const desc = (task.description || '').toLowerCase();
            const activeForm = (task.activeForm || '').toLowerCase();
            return (
                title.indexOf(keyword) !== -1 ||
                desc.indexOf(keyword) !== -1 ||
                activeForm.indexOf(keyword) !== -1
            );
        });

        let viewState;
        if (all.length === 0) {
            viewState = 'empty';
        } else if (visible.length === 0) {
            viewState = 'filtered-empty';
        } else {
            viewState = 'ready';
        }

        this.setData({
            visibleTasks: visible,
            filteredCount: visible.length,
            viewState: viewState,
        });
    },

    /**
     * 点击顶部统计卡片切换状态筛选（再次点击同一项则取消）
     */
    handleFilterTap(event) {
        const target = event.currentTarget.dataset.filter;
        if (!target) {
            return;
        }
        const next = this.data.statusFilter === target ? 'all' : target;
        this.setData({ statusFilter: next });
        this.applyFilter();
    },

    handleKeywordInput(event) {
        this.setData({ keyword: event.detail.value || '' });
        this.applyFilter();
    },

    handleClearKeyword() {
        this.setData({ keyword: '' });
        this.applyFilter();
    },

    /**
     * 清除所有筛选条件
     */
    handleResetFilter() {
        this.setData({ statusFilter: 'all', keyword: '' });
        this.applyFilter();
    },

    /**
     * 刷新：主动断开并重连，重新拉取任务快照
     * 无论当前是已连接还是断开，都强制重新走一遍连接流程，
     * 确保拿到服务端最新扫描到的任务状态。
     */
    handleRetry() {
        if (this.data.refreshing) {
            return;
        }
        this.setData({ refreshing: true });

        // 独立超时兜底：无论连接成功/失败/卡住，最多 10 秒后必定复位 refreshing
        // 防止连接 Promise 未 resolve 导致界面永远停在“刷新中”
        clearTimeout(this._refreshGuard);
        this._refreshGuard = setTimeout(() => {
            if (this.data.refreshing) {
                console.warn('[刷新] 超时兜底：强制复位 refreshing');
                this.setData({
                    refreshing: false,
                    viewState: this.data.viewState === 'loading' ? 'error' : this.data.viewState,
                    connectionState: this.data.connectionState === 'connecting' ? 'error' : this.data.connectionState,
                    errorMessage: this.data.errorMessage || '刷新超时，请检查服务端与网络',
                });
                wx.showToast({ title: '刷新超时，请重试', icon: 'none', duration: 2500 });
            }
        }, 10000);

        const finishRefresh = () => {
            clearTimeout(this._refreshGuard);
            this.setData({ refreshing: false });
            // 刷新后若处于错误状态，用 toast 明确告知原因（而不是默默停在错误页）
            if (this.data.viewState === 'error') {
                wx.showToast({
                    title: (this.data.errorMessage || '刷新失败').slice(0, 30),
                    icon: 'none',
                    duration: 3000,
                });
            }
        };

        // 主动断开旧连接（保留配置，稍后重连）
        disconnect();
        this.unsubscribe && this.unsubscribe();
        this.offStatus && this.offStatus();
        this.unsubscribe = null;
        this.offStatus = null;

        const config = loadConfig();
        if (!config) {
            finishRefresh();
            this.bootstrap();
            return;
        }

        this.connectToWorkBuddy(config)
            .then(() => finishRefresh())
            .catch(() => finishRefresh());
    },

    // ============================================================
    // 连接配置
    // ============================================================

    openSettings() {
        const config = loadConfig();
        const servers = loadServers();
        const activeServerId = servers.find(
            (s) => config && s.endpoint === config.endpoint
        )?.id || '';
        this.setData({
            settingsOpen: true,
            servers: servers,
            activeServerId: activeServerId,
            settingsEndpoint: (config && config.endpoint) || '',
            settingsToken: (config && config.token) || '',
            settingsError: '',
        });
    },

    closeSettings() {
        if (this.data.savingSettings) {
            return;
        }
        this.setData({ settingsOpen: false });
    },

    handleEndpointInput(event) {
        this.setData({ settingsEndpoint: event.detail.value, settingsError: '' });
    },

    handleTokenInput(event) {
        this.setData({ settingsToken: event.detail.value, settingsError: '' });
    },

    async handleSaveSettings() {
        if (this.data.savingSettings) {
            return;
        }

        const endpoint = (this.data.settingsEndpoint || '').trim();
        const token = (this.data.settingsToken || '').trim();

        if (!endpoint) {
            this.setData({ settingsError: '请填写连接地址' });
            return;
        }
        if (!/^wss?:\/\//.test(endpoint)) {
            this.setData({ settingsError: '地址需以 ws:// 或 wss:// 开头' });
            return;
        }
        if (!/\/ws$/.test(endpoint)) {
            this.setData({ settingsError: '地址需以 /ws 结尾（如 ws://192.168.1.5:48787/ws）' });
            return;
        }
        if (!token) {
            this.setData({ settingsError: '请填写 Token（在电脑端启动服务端时可见）' });
            return;
        }

        this.setData({ savingSettings: true, settingsError: '' });

        // 存入服务器列表（作为新增），并设为当前激活配置
        const saved = saveServer({ name: '', endpoint: endpoint, token: token });
        activateServer({ endpoint: endpoint, token: token });

        // 断开旧连接
        disconnect();

        this.setData({
            settingsOpen: false,
            savingSettings: false,
            servers: loadServers(),
        });
        await this.bootstrap();
    },

    // ============================================================
    // 模型选择面板（每个任务切换所用模型）
    // ============================================================

    /** 打开模型面板：拉取模型清单（有缓存则不重复请求） */
    async openModelPanel(event) {
        const taskId = event.currentTarget.dataset.id;
        const task = this.findTaskById(taskId);
        if (!task) {
            return;
        }
        this.setData({
            modelPanelOpen: true,
            modelPanelTaskId: task.id,
            modelPanelTaskTitle: task.title,
            modelPanelCurrent: task.model || '',
            modelsError: '',
        });

        if (this.data.models.length > 0) {
            this.applyModelFilter();
            return;
        }
        await this.loadModels();
    },

    async loadModels() {
        if (this.data.modelsLoading) {
            return;
        }
        this.setData({ modelsLoading: true, modelsError: '' });
        const { data, error } = await fetchModels();
        if (error || !data) {
            this.setData({
                modelsLoading: false,
                modelsError: (error && error.message) || '获取模型清单失败',
            });
            return;
        }
        this.setData({ models: data, modelsLoading: false });
        this.applyModelFilter();
    },

    closeModelPanel() {
        if (this.data.switchingModel) {
            return;
        }
        this.setData({ modelPanelOpen: false });
    },

    handleModelKeyword(event) {
        this.setData({ modelKeyword: event.detail.value || '' });
        this.applyModelFilter();
    },

    applyModelFilter() {
        const kw = (this.data.modelKeyword || '').trim().toLowerCase();
        const current = this.data.modelPanelCurrent;
        const list = (this.data.models || []).filter((m) => {
            if (kw && (m.id || '').toLowerCase().indexOf(kw) === -1 && (m.name || '').toLowerCase().indexOf(kw) === -1) {
                return false;
            }
            return true;
        });
        // 当前使用的模型排最前
        list.sort((a, b) => {
            const ra = a.id === current ? 0 : 1;
            const rb = b.id === current ? 0 : 1;
            return ra - rb;
        });
        this.setData({ visibleModels: list });
    },

    /** 点选模型：下发 select_model 指令 */
    async handlePickModel(event) {
        if (this.data.switchingModel) {
            return;
        }
        const modelId = event.currentTarget.dataset.modelid;
        const taskId = this.data.modelPanelTaskId;
        if (!modelId || !taskId) {
            return;
        }
        this.setData({ switchingModel: true });
        const { data, error } = await sendCommand(taskId, 'select_model', { modelId: modelId });
        this.setData({ switchingModel: false });

        if (error || !data || !data.accepted) {
            wx.showToast({
                title: (error && error.message || '切换失败').slice(0, 30),
                icon: 'none',
                duration: 3000,
            });
            return;
        }
        // accepted 只是受理，最终结果由 onCommandResponse 的 command_result 弹出。
        // 乐观更新任务本地模型显示（服务端推送会再校正）
        const tasks = (this.data.tasks || []).map((t) =>
            t.id === taskId ? Object.assign({}, t, { model: modelId }) : t
        );
        this.setData({
            tasks: tasks,
            modelPanelCurrent: modelId,
        });
        this.applyFilter();
        this.applyModelFilter();
        wx.showToast({ title: '切换指令已受理', icon: 'none', duration: 2000 });
    },

    // ============================================================
    // 服务器列表管理
    // ============================================================

    /** 新增服务器：打开空的编辑表单 */
    handleAddServer() {
        this.setData({
            editingServer: {
                id: '',           // 空 id = 新增
                name: '',
                endpoint: '',
                token: '',
            },
            settingsError: '',
        });
    },

    /** 编辑已有服务器：填充编辑表单 */
    handleEditServer(event) {
        const id = event.currentTarget.dataset.id;
        const server = (this.data.servers || []).find((s) => s.id === id);
        if (!server) {
            return;
        }
        this.setData({
            editingServer: {
                id: server.id,
                name: server.name || '',
                endpoint: server.endpoint || '',
                token: server.token || '',
            },
            settingsError: '',
        });
    },

    handleEditingNameInput(event) {
        this.setData({ 'editingServer.name': event.detail.value });
    },

    handleEditingEndpointInput(event) {
        this.setData({ 'editingServer.endpoint': event.detail.value, settingsError: '' });
    },

    handleEditingTokenInput(event) {
        this.setData({ 'editingServer.token': event.detail.value, settingsError: '' });
    },

    /** 取消编辑，关闭表单 */
    handleCancelEdit() {
        this.setData({ editingServer: null });
    },

    /** 保存编辑中的服务器（新增或更新） */
    handleSaveEditingServer() {
        const edit = this.data.editingServer;
        if (!edit) {
            return;
        }
        const endpoint = (edit.endpoint || '').trim();
        const token = (edit.token || '').trim();

        if (!endpoint) {
            this.setData({ settingsError: '请填写连接地址' });
            return;
        }
        if (!/^wss?:\/\//.test(endpoint) || !/\/ws$/.test(endpoint)) {
            this.setData({ settingsError: '地址需为 ws:// 或 wss:// 开头且以 /ws 结尾' });
            return;
        }
        if (!token) {
            this.setData({ settingsError: '请填写 Token' });
            return;
        }

        saveServer({
            id: edit.id || '',
            name: (edit.name || '').trim(),
            endpoint: endpoint,
            token: token,
        });
        this.setData({
            editingServer: null,
            servers: loadServers(),
            settingsError: '',
        });
    },

    /** 删除一个服务器 */
    handleDeleteServer(event) {
        const id = event.currentTarget.dataset.id;
        const name = ((this.data.servers || []).find((s) => s.id === id) || {}).name || '该服务器';
        wx.showModal({
            title: '删除服务器',
            content: `确定删除「${name}」吗？此操作不可恢复。`,
            confirmColor: '#d4380d',
            success: (result) => {
                if (!result.confirm) {
                    return;
                }
                removeServer(id);
                // 如果删的是当前激活项，则回到未配置状态
                if (this.data.activeServerId === id) {
                    clearConfig();
                    disconnect();
                    this.setData({
                        activeServerId: '',
                        hasConfig: false,
                        connectionState: 'unconfigured',
                        connectionMessage: '尚未配置连接信息',
                        tasks: [],
                        visibleTasks: [],
                        filteredCount: 0,
                        summary: { total: 0, pending: 0, running: 0, success: 0, failed: 0 },
                        viewState: 'loading',
                    });
                }
                this.setData({ servers: loadServers() });
            },
        });
    },

    /** 切换到某个已保存的服务器并连接 */
    handleSwitchServer(event) {
        const id = event.currentTarget.dataset.id;
        const server = (this.data.servers || []).find((s) => s.id === id);
        if (!server) {
            return;
        }
        if (this.data.activeServerId === id) {
            this.setData({ settingsOpen: false });
            return;
        }
        activateServer(server);
        disconnect();
        this.setData({
            activeServerId: id,
            settingsOpen: false,
            settingsEndpoint: server.endpoint,
            settingsToken: server.token || '',
            settingsError: '',
        });
        this.bootstrap();
    },

    handleClearConfig() {
        wx.showModal({
            title: '删除当前服务器',
            content: '将删除当前正在使用的这台电脑的服务器配置（含地址和 Token），其它服务器不受影响，确定吗？',
            confirmColor: '#d4380d',
            success: (result) => {
                if (!result.confirm) {
                    return;
                }
                // 删除当前激活项
                if (this.data.activeServerId) {
                    removeServer(this.data.activeServerId);
                }
                clearConfig();
                disconnect();
                const servers = loadServers();
                this.setData({
                    activeServerId: '',
                    servers: servers,
                    hasConfig: false,
                    connectionState: 'unconfigured',
                    connectionMessage: '尚未配置连接信息',
                    tasks: [],
                    visibleTasks: [],
                    filteredCount: 0,
                    statusFilter: 'all',
                    keyword: '',
                    summary: { total: 0, pending: 0, running: 0, success: 0, failed: 0 },
                    viewState: 'loading',
                    errorMessage: '',
                });
                // 若还有其它服务器，提示可切换；否则弹出新增
                if (servers.length > 0) {
                    this.setData({ settingsOpen: true });
                } else {
                    this.setData({ settingsOpen: true });
                    this.handleAddServer();
                }
            },
        });
    },

    // ============================================================
    // 指令交互
    // ============================================================

    openCommandPanel(event) {
        const taskId = event.currentTarget.dataset.id;
        const task = this.findTaskById(taskId);
        if (!task) {
            return;
        }

        const availableCommands = this.getAvailableCommands(task.status);
        const commandButtons = availableCommands.map((cmd) => ({
            command: cmd,
            text: this.getCommandText(cmd),
        }));

        this.setData({
            commandPanelOpen: true,
            selectedTaskId: task.id,
            selectedTaskTitle: task.title,
            availableCommands: availableCommands,
            commandButtons: commandButtons,
            commandResult: '',
            textMessage: '',
        });
    },

    closeCommandPanel() {
        if (this.data.sendingCommand) {
            return;
        }
        this.setData({
            commandPanelOpen: false,
            commandResult: '',
            textMessage: '',
        });
    },

    // ============================================================
    // 对话内容查看
    // ============================================================

    /**
     * 打开对话面板并加载指定任务的最后一条对话内容
     */
    openConvPanel(event) {
        const taskId = event.currentTarget.dataset.id;
        const task = this.findTaskById(taskId);
        if (!task) {
            return;
        }
        this.setData({
            convPanelOpen: true,
            convLoading: true,
            convRole: '',
            convText: '',
            convHasMore: false,
            convTime: '',
            convError: '',
            selectedTaskId: task.id,
            selectedTaskTitle: task.title,
        });
        this.loadConversation(task.id);
    },

    /**
     * 通过 HTTP 拉取任务最后一条对话内容并回填面板
     */
    async loadConversation(taskId) {
        const { data, error } = await fetchConversation(taskId);
        // 用户可能已经关闭面板，避免回填到已关闭的界面
        if (!this.data.convPanelOpen) {
            return;
        }
        if (error || !data) {
            this.setData({
                convLoading: false,
                convError: (error && error.message) || '未找到对话记录',
            });
            return;
        }
        this.setData({
            convLoading: false,
            convRole: data.role || '',
            convText: data.text || '',
            convHasMore: !!data.hasMore,
            convTime: data.timestamp ? this.formatConvTime(data.timestamp) : '',
        });
    },

    closeConvPanel() {
        this.setData({
            convPanelOpen: false,
            convLoading: false,
            convRole: '',
            convText: '',
            convHasMore: false,
            convTime: '',
            convError: '',
        });
    },

    formatConvTime(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return '';
        }
        const pad = (n) => (n < 10 ? '0' + n : String(n));
        const month = pad(date.getMonth() + 1);
        const day = pad(date.getDate());
        const hours = pad(date.getHours());
        const minutes = pad(date.getMinutes());
        return month + '-' + day + ' ' + hours + ':' + minutes;
    },

    getAvailableCommands(status) {
        switch (status) {
            case 'in_progress':
                return ['pause', 'resume', 'cancel'];
            case 'pending':
                // 等待中的任务可取消，也可发送「继续执行」指令
                return ['send_message', 'resume', 'cancel'];
            case 'failed':
                return ['retry'];
            case 'completed':
                return [];
            default:
                return [];
        }
    },

    handleCommandTap(event) {
        const command = event.currentTarget.dataset.command;
        if (VALID_COMMANDS.indexOf(command) === -1) {
            return;
        }
        this.sendTaskCommand(command);
    },

    async sendTaskCommand(command) {
        if (this.data.sendingCommand) {
            return;
        }

        this.setData({
            sendingCommand: true,
            commandResult: '',
        });

        const result = await sendCommand(
            this.data.selectedTaskId,
            command,
            command === 'send_message' ? { message: '请继续执行任务' } : {}
        );

        this.setData({ sendingCommand: false });

        if (result.error) {
            this.setData({
                commandResult: '指令发送失败：' + (result.error.message || '未知错误'),
            });
            return;
        }

        const commandText = {
            pause: '已暂停任务',
            resume: '已恢复任务',
            cancel: '已取消任务',
            retry: '已重新提交任务',
            send_message: '已发送继续执行指令',
        }[command] || '指令已发送';

        this.setData({
            commandResult: commandText + (result.data && result.data.message ? '：' + result.data.message : ''),
        });

        setTimeout(() => {
            this.closeCommandPanel();
        }, 2000);
    },

    handleTextMessageInput(event) {
        this.setData({ textMessage: event.detail.value });
    },

    async handleSendText() {
        const text = this.data.textMessage.trim();
        if (text === '') {
            wx.showToast({ title: '请输入内容', icon: 'none' });
            return;
        }

        if (this.data.sendingCommand) {
            return;
        }

        this.setData({
            sendingCommand: true,
            commandResult: '',
        });

        const result = await sendCommand(this.data.selectedTaskId, 'send_message', { message: text });

        this.setData({ sendingCommand: false });

        if (result.error) {
            this.setData({
                commandResult: '发送失败：' + (result.error.message || '未知错误'),
            });
            return;
        }

        this.setData({
            commandResult: '已发送：' + text,
            textMessage: '',
        });

        setTimeout(() => {
            this.closeCommandPanel();
        }, 2000);
    },

    /**
     * 任务发来带选项的选择请求
     * 将选项挂到对应任务的卡片上，由用户点选后回传
     */
    handleSelectionRequest(msg) {
        const { requestId, taskId, prompt, options } = msg || {};
        if (!requestId || !taskId || !Array.isArray(options) || options.length === 0) {
            console.warn('[选择请求] 非法消息，已忽略:', msg);
            return;
        }
        const requests = { ...this.data.selectionRequests };
        requests[taskId] = {
            requestId: requestId,
            prompt: prompt || '请做出选择',
            options: options,
        };
        this.setData({ selectionRequests: requests });

        // 让用户明确感知到「有新问题等你选」（卡片可能在列表深处/被筛掉）
        try {
            if (wx.showToast) {
                wx.showToast({ title: '有任务在等你选择', icon: 'none', duration: 2500 });
            }
        } catch (e) { /* ignore */ }

        // 若该任务不在当前列表里，刷新一次任务列表，保证卡片可见
        const list = this.data.tasks || [];
        if (!list.some((t) => t.id === taskId) && typeof this.fetchInitialTasks === 'function') {
            this.fetchInitialTasks();
        }
    },

    /**
     * 用户点选某个选项，回传选择给任务
     */
    async handleSelectOption(event) {
        const taskId = event.currentTarget.dataset.taskid;
        const requestId = event.currentTarget.dataset.requestid;
        const value = event.currentTarget.dataset.value;
        const label = event.currentTarget.dataset.label || value;

        const requests = { ...this.data.selectionRequests };
        const req = requests[taskId];
        if (!req || req.requestId !== requestId) {
            return;
        }

        if (this.data.sendingCommand) {
            return;
        }
        this.setData({ sendingCommand: true });

        const result = await sendCommand(taskId, 'select_option', {
            requestId: requestId,
            value: value,
            label: label,
        });

        this.setData({ sendingCommand: false });

        if (result.error) {
            wx.showToast({ title: '回传失败：' + (result.error.message || '未知错误'), icon: 'none' });
            return;
        }

        // 回传成功，移除该选择请求
        delete requests[taskId];
        this.setData({ selectionRequests: requests });
        wx.showToast({ title: '已选择：' + label, icon: 'none' });
    },

    /**
     * 忽略/关闭某个选择请求
     */
    handleDismissSelection(event) {
        const taskId = event.currentTarget.dataset.taskid;
        const requests = { ...this.data.selectionRequests };
        delete requests[taskId];
        this.setData({ selectionRequests: requests });
    },

    getCommandText(command) {
        switch (command) {
            case 'pause': return '暂停';
            case 'resume': return '继续';
            case 'cancel': return '取消';
            case 'retry': return '重试';
            // 「继续」按钮在面板中显示为“继续”，实际发送 send_message 指令
            case 'send_message': return '继续';
            default: return command;
        }
    },

    findTaskById(taskId) {
        const tasks = this.data.tasks || [];
        for (let i = 0; i < tasks.length; i++) {
            if (tasks[i].id === taskId) {
                return tasks[i];
            }
        }
        return null;
    },
});

function describeConnectError(error, config) {
    const endpoint = (config && config.endpoint) || '';

    if (!error) {
        return '连接失败';
    }
    if (error.code === 'TIMEOUT') {
        return '连接超时。请确认：1) 电脑端服务已启动；2) 手机与电脑连同一 WiFi；3) 地址和端口（48787）正确';
    }
    if (error.code === 'UNAUTHORIZED') {
        return 'Token 无效，请在电脑端重启服务端后重新复制 Token';
    }
    if (error.code === 'CLOSED_BEFORE_OPEN') {
        return (
            '连上后被立即断开。最常见原因是微信平台拦截了 ws:// 明文连接：' +
            '请在小程序后台配置 socket 合法域名，' +
            '或用开发者工具并勾选「详情 → 本地设置 → 不校验合法域名、web-view、TLS 版本以及 HTTPS 证书」'
        );
    }
    if (error.code === 'CONNECT_FAILED') {
        const hint =
            endpoint.indexOf('0.0.0.0') !== -1
                ? '地址里是 0.0.0.0，手机无法访问，请改成电脑的局域网 IP（服务端启动日志里有）'
                : '请检查电脑防火墙是否放行 48787 端口，以及手机是否与电脑同一 WiFi';
        return '无法建立连接：' + (error.message || '') + '。' + hint;
    }
    return error.message || '连接失败';
}

function computeSummary(tasks) {
    // 注意：tasks 里是视图模型，status 取值为
    // 'pending' | 'in_progress' | 'completed' | 'failed'
    // 而统计分组键名是 pending / running / success / failed，
    // 两者不能直接对名，必须显式映射。
    const summary = { total: tasks.length, pending: 0, running: 0, success: 0, failed: 0 };
    for (let i = 0; i < tasks.length; i++) {
        const status = tasks[i] && tasks[i].status;
        if (status === 'pending') {
            summary.pending += 1;
        } else if (status === 'in_progress') {
            summary.running += 1;
        } else if (status === 'completed') {
            summary.success += 1;
        } else if (status === 'failed') {
            summary.failed += 1;
        }
    }
    return summary;
}
