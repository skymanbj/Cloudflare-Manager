(function() {
    // 立即日志，确认脚本已加载
    console.log('%c Antigravity: [Content Script] Loaded at ' + new Date().toLocaleTimeString(), 'color: #00ff00; font-weight: bold;');

    // 检查是否带有自动化参数
    const urlParams = new URLSearchParams(window.location.search);
    const hasTrigger = urlParams.has('antigravity_auto_rename');
    
    if (!hasTrigger) {
        return;
    }

    console.log('Antigravity: [Content Script] Triggering automation...');

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

        // 寻找页面上的输入框，优先寻找在 Modal 里的或者最近出现的
        // Cloudflare 的更名输入框通常是 text 类型，且周围有 "Name" 标签
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
            .filter(input => {
                // 排除搜索框等无关输入框
                const placeholder = (input.placeholder || '').toLowerCase();
                return !placeholder.includes('search') && !placeholder.includes('filter');
            });

        if (inputs.length > 0) {
            // 假设最后一个出现的输入框是我们要找的（通常在 Modal 里）
            const targetInput = inputs[inputs.length - 1];
            
            console.log('Antigravity: [Content Script] Input found, focusing...', targetInput);
            targetInput.focus();
            
            // 选中文本，方便用户直接修改
            try {
                targetInput.select();
            } catch(e) {}

            inputFocused = true;
            return true;
        }
        return false;
    };

    // Phase 1: 寻找并点击按钮
    const tryClickButton = () => {
        if (buttonClicked) return true;
        attempts++;
        
        window.scrollTo(0, document.documentElement.scrollHeight);
        
        const candidates = Array.from(document.querySelectorAll('button, a, span, div[role="button"]'))
            .filter(el => {
                const text = el.innerText ? el.innerText.trim() : el.textContent.trim();
                return text === 'Rename' || text === '重命名' || text === '更名' || 
                       text.includes('Rename Project') || text.includes('重命名项目');
            });

        if (candidates.length > 0) {
            const target = candidates.find(el => el.tagName === 'BUTTON' || el.classList.contains('btn')) || candidates[0];
            console.log('Antigravity: [Content Script] Button found, clicking...');
            
            target.scrollIntoView({ block: 'center' });
            target.click();
            
            // 辅助点击
            const eventOptions = { bubbles: true, cancelable: true, view: window };
            target.dispatchEvent(new MouseEvent('mousedown', eventOptions));
            target.dispatchEvent(new MouseEvent('mouseup', eventOptions));
            target.dispatchEvent(new MouseEvent('click', eventOptions));

            buttonClicked = true;
            
            // 点击后立即开始寻找输入框
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

    // 启动轮询
    const mainInterval = setInterval(() => {
        if (tryClickButton() || attempts >= maxAttempts) {
            clearInterval(mainInterval);
        }
    }, 2000);

    // MutationObserver 辅助
    const observer = new MutationObserver(() => {
        if (!buttonClicked) {
            if (tryClickButton()) {
                // 已经在 tryClickButton 里处理了 startFocusPolling
            }
        } else if (!inputFocused) {
            tryFocusInput();
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

})();
