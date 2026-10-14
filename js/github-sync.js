/**
 * Cloudflare Manager - GitHub 同步核心逻辑（共用模块）
 *
 * 本文件被两处加载：
 *   - popup.html      —— <script src="js/github-sync.js">（在 popup.js 之前）
 *   - background.js   —— importScripts('js/github-sync.js')（MV3 service worker）
 *
 * 历史上 background.js 与 popup.js 各维护了一份 getRemoteData / pushData /
 * mergeRemarks / utf8ToBase64，出现过行为分叉（如 background 版不支持
 * 粘贴完整仓库 URL、未 trim token）。现统一收敛到此处，两边共用同一实现。
 *
 * 注意：本文件不使用 ES module / import 语法，保持经典脚本以兼容
 * importScripts 与 <script> 标签两种加载方式。
 */

const GitHubSyncCore = {
    // 同步数据在仓库中的文件路径
    SYNC_FILE_PATH: 'cf-remarks.json',

    // 同步数据格式版本
    DATA_VERSION: '1.0',

    /**
     * 解析仓库输入，返回 { owner, repo, branch, error }
     * 支持 "用户名/仓库名"，也支持粘贴完整的 https://github.com/用户名/仓库名(.git)
     */
    parseRepo(repoInput) {
        let value = (repoInput || '').trim();
        // 去掉协议与域名前缀、去掉 .git 后缀
        value = value
            .replace(/^(https?:\/\/)?(www\.)?github\.com\//, '')
            .replace(/\.git$/, '');

        const parts = value.split('/');
        if (parts.length < 2 || !parts[0] || !parts[1]) {
            return { error: '仓库格式错误，应为 "用户名/仓库名" (Owner/Repo)' };
        }

        // 忽略后续路径段（如 /blob/main/...）
        return { owner: parts[0], repo: parts[1] };
    },

    /**
     * 获取当前分支名（默认 main）
     */
    getBranch(config) {
        return (config && config.branch) || 'main';
    },

    /**
     * 获取清理后的 token
     */
    getToken(config) {
        return (config && config.token || '').trim();
    },

    /**
     * UTF-8 字符串转 Base64
     * 替代已废弃的 unescape()，确保中文等多字节字符编码正确
     */
    utf8ToBase64(str) {
        const bytes = new TextEncoder().encode(str);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    },

    /**
     * Base64 按 UTF-8 解码为字符串
     */
    base64ToUtf8(base64) {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return new TextDecoder('utf-8').decode(bytes);
    },

    /**
     * 校验配置是否可用
     */
    ensureConfig(config) {
        if (!config || !this.getToken(config) || !config.repo) {
            throw new Error('GitHub 同步未配置');
        }
        const parsed = this.parseRepo(config.repo);
        if (parsed.error) {
            throw new Error(parsed.error);
        }
        return parsed;
    },

    /**
     * 获取远程同步数据
     * 文件不存在（404）时返回 { remarks: {}, deletedKeys: [], sha: null }
     */
    async getRemoteData(config) {
        const { owner, repo } = this.ensureConfig(config);
        const branch = this.getBranch(config);
        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${this.SYNC_FILE_PATH}?ref=${branch}`;
        const token = this.getToken(config);

        console.log(`[GitHubSync] Fetching from ${url}`);
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Cache-Control': 'no-cache'
            },
            cache: 'no-store'
        });

        if (response.status === 404) {
            console.warn('[GitHubSync] Remote file not found (404), returning empty data.');
            return { remarks: {}, deletedKeys: [], sha: null };
        }

        if (!response.ok) {
            throw new Error(`GitHub API 错误: ${response.status}`);
        }

        const data = await response.json();
        const content = JSON.parse(this.base64ToUtf8(data.content));

        console.log(`[GitHubSync] Fetched remote data. key_count=${content.remarks ? Object.keys(content.remarks).length : 0}`);
        return { ...content, sha: data.sha };
    },

    /**
     * 推送同步数据到 GitHub
     * @param {object} config  同步配置（含 repo / token / branch）
     * @param {object} data    要写入的数据对象
     * @param {string|null} sha  远程文件当前 sha（新建文件时为 null）
     * @param {string} message  提交信息，默认 "Auto sync"
     */
    async pushData(config, data, sha, message = 'Auto sync') {
        const { owner, repo } = this.ensureConfig(config);
        const branch = this.getBranch(config);
        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${this.SYNC_FILE_PATH}`;
        const token = this.getToken(config);

        const body = {
            message: `${message} - ${new Date().toISOString()}`,
            content: this.utf8ToBase64(JSON.stringify(data, null, 2)),
            branch: branch
        };

        if (sha) {
            body.sha = sha;
        }

        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            throw new Error(`Push failed: ${response.status}`);
        }
    },

    /**
     * 合并备注数据（基于 updatedAt 时间戳，本地较新则保留本地）
     * @returns {{remarks: object, allDeletedKeys: string[]}}
     */
    mergeRemarks(local, remote, deletedKeys = []) {
        const result = {};
        const allKeys = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);
        const allDeletedKeys = [...new Set(deletedKeys)];

        for (const key of allKeys) {
            // 如果 key 在删除列表中，跳过
            if (deletedKeys.includes(key)) {
                continue;
            }

            const localItem = local[key];
            const remoteItem = remote[key];

            if (localItem && remoteItem) {
                // 两边都有，比较时间戳
                const localTime = new Date(localItem.updatedAt || 0).getTime();
                const remoteTime = new Date(remoteItem.updatedAt || 0).getTime();
                result[key] = localTime >= remoteTime ? localItem : remoteItem;
            } else if (localItem) {
                result[key] = localItem;
            } else if (remoteItem) {
                result[key] = remoteItem;
            }
        }

        return { remarks: result, allDeletedKeys };
    },

    /**
     * 构造标准同步数据结构
     */
    buildSyncPayload(remarks, deletedKeys) {
        return {
            version: this.DATA_VERSION,
            syncTime: new Date().toISOString(),
            remarks: remarks,
            deletedKeys: deletedKeys,
            metadata: {
                totalRemarks: Object.keys(remarks || {}).length
            }
        };
    }
};

// =====================================================
// GitHub Sync Manager - GitHub 备注同步管理器
// =====================================================
class GitHubSyncManager {
    constructor(manager) {
        this.manager = manager;
        this.config = null;
        this.syncInProgress = false;
        this.SYNC_FILE_PATH = GitHubSyncCore.SYNC_FILE_PATH;
    }

    // 加载配置
    async loadConfig() {
        return new Promise((resolve) => {
            chrome.storage.local.get('githubSyncConfig', (result) => {
                this.config = result.githubSyncConfig || null;
                this.updateSyncStatusUI();
                this.updateSyncSettingsUI();
                resolve(this.config);
            });
        });
    }

    // 保存配置
    async saveConfig(config) {
        this.config = config;
        return new Promise((resolve, reject) => {
            chrome.storage.local.set({ githubSyncConfig: config }, () => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    // background.js 通过 storage.onChanged 监听变化并更新定时器
                    // 无需再次发送 sendMessage，避免 "No SW" 错误
                    resolve();
                }
            });
        });
    }

    // 验证 GitHub Token
    async validateToken(token) {
        try {
            const response = await fetch('https://api.github.com/user', {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Cache-Control': 'no-cache'
                },
                cache: 'no-store'
            });
            return response.ok;
        } catch (error) {
            console.error('[GitHubSync] Token validation failed:', error);
            return false;
        }
    }

    // 获取远程数据（实现见 js/github-sync.js，与后台同步共用同一逻辑）
    async getRemoteData() {
        return GitHubSyncCore.getRemoteData(this.config);
    }

    /**
     * UTF-8 字符串转 Base64
     * 替代已废弃的 unescape()，确保中文等多字节字符编码正确
     */
    utf8ToBase64(str) {
        return GitHubSyncCore.utf8ToBase64(str);
    }

    // 推送数据到 GitHub（实现见 js/github-sync.js，与后台同步共用同一逻辑）
    async pushData(data, sha) {
        return GitHubSyncCore.pushData(this.config, data, sha, 'Manual sync');
    }

    // 执行全量同步（拉取合并后推送）
    async syncNow() {
        if (this.syncInProgress) return;

        this.syncInProgress = true;
        this.setSyncStatus('syncing', '正在同步...');

        try {
            // 获取远程数据
            let remoteData = { remarks: {}, deletedKeys: [], sha: null };
            try {
                remoteData = await this.getRemoteData();
            } catch (e) {
                if (e.message.indexOf('404') === -1 && e.message.indexOf('未配置') === -1) {
                    throw e;
                }
            }

            // 获取本地删除记录
            const { deletedKeys = [] } = await this.getLocalDeletedKeys();

            // 合并数据
            const merged = this.mergeRemarks(this.manager.remarks, remoteData.remarks || {}, [...(remoteData.deletedKeys || []), ...deletedKeys]);

            // 保存合并后的数据到本地
            this.manager.remarks = merged.remarks;
            await this.manager.saveRemarksToStorage();

            // 推送到远程
            const syncData = {
                version: '1.0',
                syncTime: new Date().toISOString(),
                remarks: merged.remarks,
                deletedKeys: merged.allDeletedKeys,
                metadata: {
                    totalRemarks: Object.keys(merged.remarks).length
                }
            };

            await this.pushData(syncData, remoteData.sha);

            // 清理本地删除记录
            await this.clearLocalDeletedKeys();

            // 更新配置时间
            this.config.lastSyncTime = new Date().toISOString();
            await this.saveConfig(this.config);

            this.setSyncStatus('connected', '同步成功');
            this.manager.showToast('同步完成', 'success');
            this.manager.refreshCurrentView();

        } catch (error) {
            console.error('[GitHubSync] Sync failed:', error);
            this.setSyncStatus('error', '同步失败');
            this.manager.showToast('同步失败: ' + error.message, 'error');
        } finally {
            this.syncInProgress = false;
        }
    }

    // 只拉取远程数据
    async pullFromGithub() {
        if (this.syncInProgress) return;

        this.syncInProgress = true;
        this.setSyncStatus('syncing', '正在拉取...');

        try {
            const remoteData = await this.getRemoteData();

            // Check for 404 (sha is null)
            if (!remoteData.sha) {
                const [owner, repo] = (this.config.repo || '').split('/');
                const branch = this.config.branch || 'main';

                console.warn(`[GitHubSync] File not found: ${owner}/${repo}/${this.SYNC_FILE_PATH}`);

                this.setSyncStatus('error', '文件未找到');
                this.manager.showToast(`错误: 远程文件 ${this.SYNC_FILE_PATH} 不存在 (404)\n请检查分支: ${branch}`, 'error');

                this.syncInProgress = false;
                return;
            }

            const remoteCount = remoteData.remarks ? Object.keys(remoteData.remarks).length : 0;
            console.log(`[GitHubSync] Pull success. Remote keys: ${remoteCount}`);

            // 处理删除的 key
            if (remoteData.deletedKeys) {
                for (const key of remoteData.deletedKeys) {
                    delete this.manager.remarks[key];
                }
            }

            // 合并远程数据（远程优先）
            if (remoteData.remarks) {
                Object.assign(this.manager.remarks, remoteData.remarks);
            }

            const totalCount = Object.keys(this.manager.remarks).length;
            console.log(`[GitHubSync] Merged local keys. Total keys: ${totalCount}`);

            await this.manager.saveRemarksToStorage();

            this.config.lastSyncTime = new Date().toISOString();
            await this.saveConfig(this.config);

            this.setSyncStatus('connected', '拉取成功');
            this.manager.showToast(`拉取完成 (共 ${totalCount} 条备注)`, 'success');
            this.manager.refreshCurrentView();

        } catch (error) {
            this.setSyncStatus('error', '拉取失败');
            this.manager.showToast('拉取失败: ' + error.message, 'error');
        } finally {
            this.syncInProgress = false;
        }
    }

    // 只推送本地数据
    async pushToGithub() {
        if (this.syncInProgress) return;

        this.syncInProgress = true;
        this.setSyncStatus('syncing', '正在推送...');

        try {
            // 先获取远程 sha
            let sha = null;
            try {
                const remoteData = await this.getRemoteData();
                sha = remoteData.sha;
            } catch (e) {
                // 文件不存在，不需要 sha
            }

            const { deletedKeys = [] } = await this.getLocalDeletedKeys();

            const syncData = {
                version: '1.0',
                syncTime: new Date().toISOString(),
                remarks: this.manager.remarks,
                deletedKeys: deletedKeys,
                metadata: {
                    totalRemarks: Object.keys(this.manager.remarks).length
                }
            };

            await this.pushData(syncData, sha);
            await this.clearLocalDeletedKeys();

            this.config.lastSyncTime = new Date().toISOString();
            await this.saveConfig(this.config);

            this.setSyncStatus('connected', '推送成功');
            this.manager.showToast('推送完成', 'success');

        } catch (error) {
            this.setSyncStatus('error', '推送失败');
            this.manager.showToast('推送失败: ' + error.message, 'error');
        } finally {
            this.syncInProgress = false;
        }
    }

    // 合并备注数据（基于时间戳，实现见 js/github-sync.js）
    mergeRemarks(local, remote, deletedKeys = []) {
        return GitHubSyncCore.mergeRemarks(local, remote, deletedKeys);
    }

    // 记录删除操作
    async recordDeletion(key) {
        return new Promise((resolve) => {
            chrome.storage.local.get('githubSyncDeletedKeys', (result) => {
                const deletedKeys = result.githubSyncDeletedKeys || [];
                if (!deletedKeys.includes(key)) {
                    deletedKeys.push(key);
                }
                chrome.storage.local.set({ githubSyncDeletedKeys: deletedKeys }, resolve);
            });
        });
    }

    // 获取本地删除记录
    async getLocalDeletedKeys() {
        return new Promise((resolve) => {
            chrome.storage.local.get('githubSyncDeletedKeys', (result) => {
                resolve({ deletedKeys: result.githubSyncDeletedKeys || [] });
            });
        });
    }

    // 清除本地删除记录
    async clearLocalDeletedKeys() {
        return new Promise((resolve) => {
            chrome.storage.local.remove('githubSyncDeletedKeys', resolve);
        });
    }

    // 更新同步状态 UI
    setSyncStatus(status, text) {
        const statusEl = document.getElementById('syncStatus');
        if (!statusEl) return;

        statusEl.className = `sync-status ${status}`;
        const iconEl = statusEl.querySelector('.sync-status-icon');
        const textEl = statusEl.querySelector('.sync-status-text');

        if (iconEl) {
            const icons = { connected: '🟢', syncing: '🔄', error: '🔴', '': '⚪' };
            iconEl.textContent = icons[status] || '⚪';
        }
        if (textEl) {
            textEl.textContent = text;
        }
    }

    // 更新同步状态 UI（基于配置）
    updateSyncStatusUI() {
        if (!this.config?.enabled) {
            this.setSyncStatus('', '未配置');
        } else if (this.config.lastSyncTime) {
            const lastSync = new Date(this.config.lastSyncTime);
            this.setSyncStatus('connected', `已连接`);

            const lastSyncEl = document.getElementById('lastSyncTime');
            if (lastSyncEl) {
                lastSyncEl.textContent = `上次同步: ${lastSync.toLocaleString('zh-CN')}`;
            }
        } else {
            this.setSyncStatus('connected', '已配置，等待首次同步');
        }
    }

    // 更新设置面板 UI
    updateSyncSettingsUI() {
        const enableCheckbox = document.getElementById('enableGithubSync');
        const settingsDiv = document.getElementById('githubSyncSettings');
        const tokenInput = document.getElementById('githubToken');
        const repoInput = document.getElementById('githubRepo');
        const branchInput = document.getElementById('githubBranch');
        const timerCheckbox = document.getElementById('enableTimerSync');
        const intervalGroup = document.getElementById('syncIntervalGroup');
        const intervalSelect = document.getElementById('syncInterval');

        if (this.config) {
            if (enableCheckbox) enableCheckbox.checked = this.config.enabled || false;
            if (settingsDiv) settingsDiv.style.display = this.config.enabled ? 'block' : 'none';
            if (tokenInput) tokenInput.value = this.config.token || '';
            if (repoInput) repoInput.value = this.config.repo || '';
            if (branchInput) branchInput.value = this.config.branch || 'main';
            if (timerCheckbox) timerCheckbox.checked = this.config.timerSync || false;
            if (intervalGroup) intervalGroup.style.display = this.config.timerSync ? 'block' : 'none';
            if (intervalSelect) intervalSelect.value = this.config.syncInterval || '30';
        }
    }
}
