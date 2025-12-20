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
      return true;
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

console.log("[CloudflareManager] Background service worker initialized");
