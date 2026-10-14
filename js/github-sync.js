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
