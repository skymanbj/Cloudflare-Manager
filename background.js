/**
 * Cloudflare Manager - Background Service Worker
 * 简化版，只保留核心功能
 */

console.log("[CloudflareManager] Background service worker started");

// =====================================================
// 点击扩展图标时打开管理页面
// =====================================================
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({
    url: chrome.runtime.getURL('popup.html')
  });
});

// =====================================================
// 处理扩展安装/更新
// =====================================================
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[CloudflareManager] Extension installed');
    // 安装后自动打开管理页面
    chrome.tabs.create({
      url: chrome.runtime.getURL('popup.html')
    });
  } else if (details.reason === 'update') {
    console.log('[CloudflareManager] Updated to version', chrome.runtime.getManifest().version);
  }
});

// =====================================================
// 消息处理
// =====================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("[Background] Received message:", request.type || request.action);

  try {
    // 获取版本信息
    if (request.action === 'getVersion') {
      sendResponse({ version: chrome.runtime.getManifest().version });
      return true;
    }

    // 获取存储使用情况
    if (request.type === "GET_STORAGE_USAGE") {
      handleGetStorageUsage(sendResponse);
      return true; // Keep channel open for async response
    }
  } catch (error) {
    console.error("[Background] Error handling message:", error);
    sendResponse({ success: false, error: error.message });
    return false;
  }
});

// =====================================================
// 存储使用情况
// =====================================================

/**
 * 处理获取存储使用情况
 */
async function handleGetStorageUsage(sendResponse) {
  try {
    const bytesInUse = await chrome.storage.local.getBytesInUse(null);

    const manifest = chrome.runtime.getManifest();
    const hasUnlimitedStorage = manifest.permissions && manifest.permissions.includes('unlimitedStorage');

    const QUOTA_BYTES = hasUnlimitedStorage
      ? 1024 * 1024 * 1024  // 1GB
      : 5 * 1024 * 1024;    // 5MB

    const percentage = Math.min(100, Math.round((bytesInUse / QUOTA_BYTES) * 100));

    sendResponse({
      success: true,
      data: {
        used: bytesInUse,
        quota: QUOTA_BYTES,
        percentage: percentage,
        unlimited: hasUnlimitedStorage
      }
    });
  } catch (error) {
    console.error("[CloudflareManager] Failed to get storage usage:", error);
    sendResponse({ success: false, error: error.message });
  }
}


// =====================================================
// GitHub 定时同步
// =====================================================
const SYNC_ALARM_NAME = 'github-sync-alarm';
const SYNC_FILE_PATH = 'cf-remarks.json';

/**
 * 设置定时同步
 */
function setupSyncAlarm(intervalMinutes) {
  chrome.alarms.clear(SYNC_ALARM_NAME, () => {
    if (intervalMinutes > 0) {
      chrome.alarms.create(SYNC_ALARM_NAME, {
        delayInMinutes: intervalMinutes,
        periodInMinutes: intervalMinutes
      });
      console.log(`[Sync] Alarm set: every ${intervalMinutes} minutes`);
    }
  });
}

/**
 * 监听定时器触发
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SYNC_ALARM_NAME) {
    console.log('[Sync] Timer triggered, starting sync...');
    await performBackgroundSync();
  }
});

/**
 * 后台执行同步
 */
async function performBackgroundSync() {
  try {
    const { githubSyncConfig } = await chrome.storage.local.get('githubSyncConfig');
    if (!githubSyncConfig?.enabled || !githubSyncConfig?.timerSync) {
      console.log('[Sync] Sync disabled, skipping');
      return;
    }

    const { cfRemarks } = await chrome.storage.local.get('cfRemarks');
    const remarks = cfRemarks || {};

    // 获取远程数据
    const remoteData = await getRemoteData(githubSyncConfig);

    // 合并数据
    const merged = mergeRemarks(remarks, remoteData.remarks || {}, remoteData.deletedKeys || []);

    // 保存到本地
    await chrome.storage.local.set({ cfRemarks: merged.remarks });

    // 推送到远程
    const syncData = {
      version: '1.0',
      syncTime: new Date().toISOString(),
      remarks: merged.remarks,
      deletedKeys: merged.allDeletedKeys,
      metadata: { totalRemarks: Object.keys(merged.remarks).length }
    };

    await pushData(githubSyncConfig, syncData, remoteData.sha);

    // 更新最后同步时间
    githubSyncConfig.lastSyncTime = new Date().toISOString();
    await chrome.storage.local.set({ githubSyncConfig });

    console.log('[Sync] Background sync completed');
  } catch (error) {
    console.error('[Sync] Background sync failed:', error);
  }
}

/**
 * 获取远程数据
 */
async function getRemoteData(config) {
  const [owner, repo] = config.repo.split('/');
  const branch = config.branch || 'main';
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${SYNC_FILE_PATH}?ref=${branch}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${config.token}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (response.status === 404) {
    return { remarks: {}, deletedKeys: [], sha: null };
  }

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const data = await response.json();
  const content = JSON.parse(atob(data.content));
  return { ...content, sha: data.sha };
}

/**
 * 推送数据到 GitHub
 */
async function pushData(config, data, sha) {
  const [owner, repo] = config.repo.split('/');
  const branch = config.branch || 'main';
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${SYNC_FILE_PATH}`;

  const body = {
    message: `Auto sync - ${new Date().toISOString()}`,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2)))),
    branch: branch
  };

  if (sha) {
    body.sha = sha;
  }

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${config.token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Push failed: ${response.status}`);
  }
}

/**
 * 合并备注数据
 */
function mergeRemarks(local, remote, deletedKeys = []) {
  const result = {};
  const allKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  const allDeletedKeys = [...new Set(deletedKeys)];

  for (const key of allKeys) {
    if (deletedKeys.includes(key)) continue;

    const localItem = local[key];
    const remoteItem = remote[key];

    if (localItem && remoteItem) {
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
}

/**
 * 监听配置变化，自动更新定时器
 */
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.githubSyncConfig) {
    const config = changes.githubSyncConfig.newValue;
    if (config?.enabled && config?.timerSync) {
      setupSyncAlarm(config.syncInterval || 30);
    } else {
      chrome.alarms.clear(SYNC_ALARM_NAME);
      console.log('[Sync] Alarm cleared');
    }
  }
});

/**
 * 扩展启动时恢复定时器
 */
chrome.storage.local.get('githubSyncConfig', (result) => {
  const githubSyncConfig = result?.githubSyncConfig;
  if (githubSyncConfig?.enabled && githubSyncConfig?.timerSync) {
    setupSyncAlarm(githubSyncConfig.syncInterval || 30);
    console.log('[Sync] Restored sync alarm on startup');
  }
});

console.log("[CloudflareManager] Background service worker initialized");
