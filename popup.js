// ==================== 유틸 ====================
let statusTimeout = null;

const setStatus = (msg, type = '') => {
    const el = document.getElementById('statusMessage');
    el.textContent = msg;
    el.className = 'status ' + type;

    // 이전에 설정된 타이머가 있다면 취소
    if (statusTimeout) clearTimeout(statusTimeout);

    // 성공(success)이나 오류(error) 메시지의 경우 2.5초 후 자동으로 사라짐
    if (type === 'success' || type === 'error') {
        statusTimeout = setTimeout(() => {
            el.className = 'status'; // 클래스 초기화 (내려가는 애니메이션 트리거)
            statusTimeout = setTimeout(() => {
                el.textContent = ''; // 애니메이션 완료 후 텍스트 제거
            }, 400);
        }, 2500);
    }
};

const getTab = () =>
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab);

// ==================== 🌐 다국어 설정 (i18n) ====================
const translations = {
    ko: {
        titleSettings: "임베딩 설정",
        labelModel: "임베딩 모델",
        labelLanguage: "언어 (Language)",
        optAuto: "자동 감지 (Auto)",
        labelApiKey: "Gemini API Key",
        linkGetApiKey: "API key 발급",
        btnSaveSettings: "설정 저장",
        btnExtract: "영상 내용 추출",
        titleSearch: "원하는 영상을 검색해보세요",
        descSearch: "영상에서 기억나는 부분을 검색하거나\n영상의 주제 등을 검색해보세요.",
        placeholderSearch: "검색어를 입력하세요",
        titleSavedMemory: "저장된 기록",
        btnClearAll: "전체 삭제",
        msgExtracting: "추출 중...",
        msgSaved: "저장 완료",
        msgSearching: "검색 중...",
        msgResults: "개 결과",
        msgEmpty: "저장된 영상이 없습니다",
        msgLoading: "불러오는 중…",
        msgFail: "불러오기 실패",
        msgSettingsSaved: "설정 저장됨",
        confirmDeleteAll: "저장된 영상을 모두 삭제할까요?",
        btnCopy: "URL 복사",
        btnDelete: "삭제",
        scoreLabel: "유사도"
    },
    en: {
        titleSettings: "Settings",
        labelModel: "Embedding Model",
        labelLanguage: "Language",
        optAuto: "Auto Detect",
        labelApiKey: "Gemini API Key",
        linkGetApiKey: "Get API key",
        btnSaveSettings: "Save Settings",
        btnExtract: "Extract Video Info",
        titleSearch: "Search for videos",
        descSearch: "Search for parts you remember\nor the topic of the video.",
        placeholderSearch: "Enter search terms...",
        titleSavedMemory: "Saved Records",
        btnClearAll: "Clear All",
        msgExtracting: "Extracting...",
        msgSaved: "Saved Successfully",
        msgSearching: "Searching...",
        msgResults: " results",
        msgEmpty: "No saved videos",
        msgLoading: "Loading...",
        msgFail: "Failed to load",
        msgSettingsSaved: "Settings Saved",
        confirmDeleteAll: "Clear all saved records?",
        btnCopy: "Copy URL",
        btnDelete: "Delete",
        scoreLabel: "Sim."
    }
};

let currentLang = 'en';

function applyLanguage(lang) {
    let targetLang = lang;

    if (lang === 'auto') {
        const browserLang = navigator.language.toLowerCase();
        targetLang = browserLang.startsWith('ko') ? 'ko' : 'en';
    }

    currentLang = targetLang;
    const dict = translations[targetLang];

    // 1. 텍스트 변경
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (dict[key]) el.textContent = dict[key];
    });

    // 2. 플레이스홀더 변경
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (dict[key]) el.placeholder = dict[key];
    });

    // 3. title 및 aria-label 속성 변경 (필요시)
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        if (dict[key]) el.title = dict[key];
    });
}

// 뱃지 업데이트
function updateBadge(count) {
    // 빨간 점 제거 요청에 따라 로직 비움
}

// ==================== ⚙ 설정 패널 ====================
const settingsToggleBtn = document.getElementById('settingsToggleBtn');
const settingsPanel = document.getElementById('settingsPanel');
const apiKeyInput = document.getElementById('apiKeyInput');
const toggleKeyVisBtn = document.getElementById('toggleKeyVisBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
let originalSettings = { apiKey: '', lang: 'auto' };

// 설정 변경 감지 함수
const checkSettingsChanged = () => {
    const currentApiKey = apiKeyInput.value.trim();
    const currentLang = document.getElementById('languageSelect').value;

    const isChanged = currentApiKey !== originalSettings.apiKey ||
        currentLang !== originalSettings.lang;

    saveSettingsBtn.classList.toggle('modified', isChanged);
};

// 저장된 설정 불러오기
chrome.storage.local.get(['geminiApiKey', 'appLanguage'], (data) => {
    apiKeyInput.value = data.geminiApiKey || '';

    if (data.appLanguage) {
        document.getElementById('languageSelect').value = data.appLanguage;
        applyLanguage(data.appLanguage);
    } else {
        applyLanguage('auto');
    }

    // 초기 스냅샷 저장
    originalSettings = {
        apiKey: apiKeyInput.value.trim(),
        lang: document.getElementById('languageSelect').value
    };
});

// 입력 요소들 변경 감지 리스너
apiKeyInput.addEventListener('input', checkSettingsChanged);
document.getElementById('languageSelect').addEventListener('change', checkSettingsChanged);

// Settings 페이지 토글
settingsToggleBtn.addEventListener('click', () => {
    pageWrapper.classList.remove('show-list');
    pageWrapper.classList.add('show-settings');
});

// Settings -> Main 복귀
document.getElementById('backToMainFromSettings').addEventListener('click', () => {
    pageWrapper.classList.remove('show-settings');
});

// API Key 표시/숨기기
toggleKeyVisBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    document.getElementById('eyeIcon').style.opacity = isPassword ? '0.5' : '1';
});

// 설정 저장
saveSettingsBtn.addEventListener('click', () => {
    const apiKey = apiKeyInput.value.trim();
    const lang = document.getElementById('languageSelect').value;

    if (!apiKey) {
        const errorMsg = currentLang === 'ko' ? `Gemini API Key를 입력해 주세요` : `Please enter Gemini API Key`;
        setStatus(errorMsg, 'error');
        return;
    }

    // Gemini 전용 키로 저장
    chrome.storage.local.set({
        geminiApiKey: apiKey,
        appLanguage: lang
    }, () => {
        // 메모리 업데이트
        originalSettings = { apiKey, lang };
        saveSettingsBtn.classList.remove('modified');

        applyLanguage(lang);
        setStatus(translations[currentLang].msgSettingsSaved, 'success');
    });
});

// ==================== 검색 로직 ====================
const searchInput = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const mainEmptyState = document.getElementById('mainEmptyState');
const resultsContainer = document.getElementById('results');

searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        performSearch();
    }
});

searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim();
    
    // 지우기 버튼 표시 여부
    clearSearchBtn.style.display = query.length > 0 ? 'block' : 'none';

    if (query.length === 0) {
        mainEmptyState.style.display = 'flex';
        resultsContainer.style.display = 'none';
        resultsContainer.innerHTML = '';
        setStatus('');
    }
});

clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearSearchBtn.style.display = 'none';
    mainEmptyState.style.display = 'flex';
    resultsContainer.style.display = 'none';
    resultsContainer.innerHTML = '';
    setStatus('');
    searchInput.focus();
});

// ==================== 추출(저장) ====================
document.getElementById('saveBtn').addEventListener('click', async () => {
    const tab = await getTab();

    // 유튜브 페이지인지 확인
    if (!tab.url || !tab.url.includes('youtube.com')) {
        setStatus(currentLang === 'ko' ? '유튜브 페이지에서만 추출할 수 있습니다.' : 'Can only extract on YouTube pages.', 'error');
        return;
    }

    setStatus(translations[currentLang].msgExtracting, 'loading');

    // 탭으로 먼저 추출 요청 (content script)
    chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_TEXTS' }, (response) => {
        if (chrome.runtime.lastError) {
            setStatus(currentLang === 'ko' ? '페이지를 새로고침한 뒤 다시 시도해주세요.' : 'Please refresh the page and try again.', 'error');
            return;
        }

        if (response?.success) {
            setStatus(`${translations[currentLang].msgSaved} (${response.saved})`, 'success');
            // 목록 페이지가 열려 있다면 갱신
            if (pageWrapper.classList.contains('show-list')) loadVideoList();
        } else {
            setStatus(response?.error ?? 'Error', 'error');
        }
    });
});

async function performSearch() {
    const query = searchInput.value.trim();
    if (!query) return;

    mainEmptyState.style.display = 'none';
    resultsContainer.style.display = 'flex';
    resultsContainer.innerHTML = '';
    setStatus(translations[currentLang].msgSearching, 'loading');

    // 검색은 백그라운드 스크립트로 전달
    chrome.runtime.sendMessage({ type: 'SEARCH', query }, (response) => {
        if (!response?.success) {
            setStatus(response?.error ?? 'Error', 'error');
            return;
        }

        setStatus(`${response.results.length}${translations[currentLang].msgResults}`, 'success');
        const container = resultsContainer;

        response.results.forEach(r => {
            const item = document.createElement('div');
            item.className = 'result-item';
            item.innerHTML = `
                <img src="https://img.youtube.com/vi/${r.videoId}/mqdefault.jpg"
                     style="width:100%;border-radius:7px;margin-bottom:7px;display:block;">
                <div class="result-title">${r.title}</div>
                <div class="result-snippet">${r.text}</div>
            `;
            item.addEventListener('click', () => {
                const url = r.startTime != null
                    ? `https://www.youtube.com/watch?v=${r.videoId}&t=${r.startTime}`
                    : r.url;
                chrome.tabs.create({ url });
            });
            container.appendChild(item);
        });
    });
}

// ==================== 페이지 전환 (슬라이드 애니메이션) ====================
const docsBtn = document.getElementById('docsBtn');
const pageWrapper = document.getElementById('pageWrapper');

// 문서 아이콘 클릭 -> 목록 페이지로 이동
docsBtn.addEventListener('click', async () => {
    pageWrapper.classList.remove('show-settings'); // 설정이 열려있다면 닫음
    // 1. 목록 데이터를 먼저 불러옴 (높이 계산 준비)
    loadVideoList();

    // 2. 애니메이션 실행
    pageWrapper.classList.add('show-list');
});

// 뒤로가기 아이콘들 클릭 -> 메인 페이지로 복귀
const goMain = () => {
    pageWrapper.classList.remove('show-list', 'show-settings');
};
document.getElementById('backToMainFromSettings')?.addEventListener('click', goMain);
document.getElementById('backToMainFromList')?.addEventListener('click', goMain);

// ==================== 목록 불러오기 ====================
function loadVideoList() {
    const container = document.getElementById('videoList');
    const clearAllBtn = document.getElementById('clearAllBtn');
    container.innerHTML = `<div class="empty-msg">${translations[currentLang].msgLoading}</div>`;

    // 백그라운드 스크립트로 전달
    chrome.runtime.sendMessage({ type: 'GET_VIDEOS' }, (response) => {
        container.innerHTML = '';

        if (!response?.success) {
            container.innerHTML = `<div class="empty-msg">${translations[currentLang].msgFail}</div>`;
            clearAllBtn.style.display = 'none';
            updateBadge(0);
            return;
        }

        const videos = response.videos;
        updateBadge(videos.length);

        if (videos.length === 0) {
            container.innerHTML = `<div class="empty-msg">${translations[currentLang].msgEmpty}</div>`;
            clearAllBtn.style.display = 'none';
            return;
        }

        clearAllBtn.style.display = 'block';
        videos.forEach(video => {
            container.appendChild(buildVideoItem(video, container, clearAllBtn));
        });
    });
}

// ==================== 영상 아이템 생성 ====================
function buildVideoItem(video, container, clearAllBtn) {
    const date = new Date(video.savedAt).toLocaleDateString('ko-KR');
    const item = document.createElement('div');
    item.className = 'video-item';
    item.innerHTML = `
        <img src="https://img.youtube.com/vi/${video.videoId}/mqdefault.jpg" class="video-thumbnail">
        <div class="video-info">
            <div class="video-item-title">${video.title}</div>
        </div>
        <div class="video-footer">
            <div class="video-item-date">${date}</div>
            <div class="video-actions">
                <button class="icon-btn copy-btn" title="${translations[currentLang].btnCopy}">⎘</button>
                <button class="icon-btn delete-btn" title="${translations[currentLang].btnDelete}">✕</button>
            </div>
        </div>
    `;

    item.querySelector('.video-info').addEventListener('click', () => {
        chrome.tabs.create({ url: video.url });
    });

    item.querySelector('.copy-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const url = video.url;

        // 가장 확실한 복사 방법: 임시 textarea 활용
        const textArea = document.createElement("textarea");
        textArea.value = url;
        document.body.appendChild(textArea);
        textArea.select();

        try {
            const successful = document.execCommand('copy');
            if (!successful) throw new Error();

            const btn = e.currentTarget;
            btn.classList.add('copied');
            btn.textContent = '✓';

            // 성공 알림 추가
            const successMsg = currentLang === 'ko' ? 'URL 복사 완료' : 'URL Copied';
            setStatus(successMsg, 'success');

            setTimeout(() => {
                btn.classList.remove('copied');
                btn.textContent = '⎘';
            }, 1200);
        } catch (err) {
            const failMsg = currentLang === 'ko' ? '복사 실패' : 'Copy Failed';
            setStatus(failMsg, 'error');
        } finally {
            document.body.removeChild(textArea);
        }
    });

    item.querySelector('.delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'DELETE_VIDEO', videoId: video.videoId }, (res) => {
            if (res?.success) {
                item.remove();
                const remaining = container.querySelectorAll('.video-item').length;
                updateBadge(remaining);
                if (remaining === 0) {
                    container.innerHTML = '<div class="empty-msg">저장된 영상이 없습니다</div>';
                    clearAllBtn.style.display = 'none';
                }
            }
        });
    });

    return item;
}

// ==================== 전체 삭제 ====================
document.getElementById('clearAllBtn').addEventListener('click', async () => {
    const confirmed = confirm(translations[currentLang].confirmDeleteAll);
    if (!confirmed) return;

    const container = document.getElementById('videoList');
    const clearAllBtn = document.getElementById('clearAllBtn');

    chrome.runtime.sendMessage({ type: 'CLEAR_ALL_VIDEOS' }, (res) => {
        if (res?.success) {
            container.innerHTML = `<div class="empty-msg">${translations[currentLang].msgEmpty}</div>`;
            clearAllBtn.style.display = 'none';
            updateBadge(0);
            setStatus(currentLang === 'ko' ? '전체 삭제 완료' : 'All cleared', 'success');
        } else {
            setStatus(currentLang === 'ko' ? '삭제 실패' : 'Failed to clear', 'error');
        }
    });
});
