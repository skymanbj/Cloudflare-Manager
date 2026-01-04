(function() {
    console.log('%c Antigravity: [Content Script] Loaded at ' + new Date().toLocaleTimeString(), 'color: #00ff00; font-weight: bold;');

    const urlParams = new URLSearchParams(window.location.search);
    const hasTrigger = urlParams.has('antigravity_auto_rename');
    
    if (!hasTrigger) return;

    console.log('Antigravity: [Content Script] Automation triggered');

    // 延迟清理参数
    setTimeout(() => {
        const cleanUrl = window.location.origin + window.location.pathname + window.location.search.replace(/[?&]antigravity_auto_rename=1/, '');
        window.history.replaceState({ path: cleanUrl }, '', cleanUrl);
    }, 5000);

    let attempts = 0;
    const maxAttempts = 30; 
    let buttonClicked = false;
    let inputFocused = false;

    // Phase 2: 寻找并聚焦输入框
    const tryFocusInput = () => {
        if (inputFocused) return true;

        // Cloudflare 的更名输入框通常具有特征
        // 1. 它是当前显示的 modal 或部分中的唯一的输入框
        // 2. 它可能有 name="name" 属性
        const allInputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
        
        // 过滤规则：
        // - 必须是可见的
        // - 优先匹配 name="name" 或者 id 包含 "name" 的
        // - 排除掉搜索框
        const possibleInputs = allInputs.filter(input => {
            const rect = input.getBoundingClientRect();
            const isVisible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(input).display !== 'none';
            if (!isVisible) return false;

            const name = (input.name || '').toLowerCase();
            const id = (input.id || '').toLowerCase();
            const placeholder = (input.placeholder || '').toLowerCase();
            
            // 排除明显的搜索/过滤框
            if (placeholder.includes('search') || placeholder.includes('filter') || id.includes('search')) return false;

            return true;
        });

        if (possibleInputs.length > 0) {
            // 优先权：1. name="name", 2. 最后一个可见的输入框（SPA Modal 通常是最后插入）
            const targetInput = possibleInputs.find(i => i.name === 'name') || possibleInputs[possibleInputs.length - 1];
            
            console.log('Antigravity: [Content Script] Target input detected:', targetInput);
            
            // 强力聚焦：尝试多次且使用多种方法
            const focusMe = () => {
                targetInput.focus();
                targetInput.select();
                // 某些 React 组件需要触发一次 input 事件来激活底层逻辑
                targetInput.dispatchEvent(new Event('input', { bubbles: true }));
                // 添加一个临时的高亮边框，帮助用户确认
                targetInput.style.outline = '2px solid #00ff00';
            };

            focusMe();
            // 延迟一点再试一次，防止被 SPA 框架重新夺走焦点
            setTimeout(focusMe, 100);
            setTimeout(focusMe, 500);

            inputFocused = true;
            console.log('%c Antigravity: [Content Script] Input focused and selected!', 'color: #00ff00; font-weight: bold;');
            return true;
        }
        return false;
    };

    // Phase 1: 寻找并点击按钮
    const tryClickButton = () => {
        if (buttonClicked) return true;
        attempts++;
        
        // 如果是 Worker 页面，可能需要滚屏；Pages 页面按钮就在设置底部
        window.scrollTo(0, document.documentElement.scrollHeight);
        
        const candidates = Array.from(document.querySelectorAll('button, a, span, div[role="button"]'))
            .filter(el => {
                const text = el.innerText ? el.innerText.trim() : el.textContent.trim();
                return text === 'Rename' || text === '重命名' || text === '更名' || 
                       text.includes('Rename Project') || text.includes('重命名项目');
            });

        if (candidates.length > 0) {
            const target = candidates.find(el => el.tagName === 'BUTTON' || el.classList.contains('btn')) || candidates[0];
            console.log('Antigravity: [Content Script] "Rename" button found, clicking...');
            
            target.scrollIntoView({ block: 'center' });
            
            // 模拟真实交互
            const eventOptions = { bubbles: true, cancelable: true, view: window };
            target.dispatchEvent(new MouseEvent('mousedown', eventOptions));
            target.dispatchEvent(new MouseEvent('mouseup', eventOptions));
            target.click();

            buttonClicked = true;
            startFocusPolling();
            return true;
        }
        return false;
    };

    const startFocusPolling = () => {
        let focusAttempts = 0;
        const maxFocusAttempts = 20;
        
        const focusInterval = setInterval(() => {
            focusAttempts++;
            if (tryFocusInput() || focusAttempts >= maxFocusAttempts) {
                clearInterval(focusInterval);
            }
        }, 500);
    };

    // 主巡检器
    const mainInterval = setInterval(() => {
        if (!buttonClicked) {
            if (tryClickButton() && buttonClicked) {
                // 如果第一次就点到了，启动后续波次
            }
        } else if (!inputFocused) {
            tryFocusInput();
        }

        if (buttonClicked && inputFocused || attempts >= maxAttempts) {
            clearInterval(mainInterval);
        }
    }, 2000);

    // DOM 变化监听
    const observer = new MutationObserver(() => {
        if (!buttonClicked) {
           tryClickButton();
        } else if (!inputFocused) {
           tryFocusInput();
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

})();
