// ==================== 유틸 ====================
const setStatus = (msg, type = '') => {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = 'status ' + type;
};

const getTab = () =>
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab);

// ==================== 뱃지 업데이트 ====================
function updateBadge(count) {
    const badge = document.getElementById('videoCount');
    badge.textContent = count;
    badge.style.display = count > 0 ? 'inline-flex' : 'none';
}

// ==================== 검색창 X 버튼 ====================
const searchInput = document.getElementById('searchInput');
const clearBtn = document.getElementById('clearBtn');

searchInput.addEventListener('input', () => {
    clearBtn.style.display = searchInput.value.length > 0 ? 'block' : 'none';
});

clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.style.display = 'none';
    document.getElementById('results').innerHTML = '';
    setStatus('');
    searchInput.focus();
});

// ==================== Enter 키 검색 ====================
searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('searchBtn').click();
});

// ==================== 저장 ====================
document.getElementById('saveBtn').addEventListener('click', async () => {
    const tab = await getTab();
    setStatus('추출 중...', 'loading');

    chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_TEXTS' }, (response) => {
        if (response?.success) {
            setStatus(`저장 완료 (${response.saved}개 청크)`, 'success');
            // 목록이 열려 있으면 갱신
            if (listOpen) loadVideoList(tab);
        } else {
            setStatus(response?.error ?? '오류 발생', 'error');
        }
    });
});

// ==================== 검색 ====================
document.getElementById('searchBtn').addEventListener('click', async () => {
    const query = searchInput.value.trim();
    if (!query) return;

    const tab = await getTab();
    setStatus('검색 중...', 'loading');
    document.getElementById('results').innerHTML = '';

    chrome.tabs.sendMessage(tab.id, { type: 'SEARCH', query }, (response) => {
        if (!response?.success) {
            setStatus(response?.error ?? '오류 발생', 'error');
            return;
        }

        setStatus(`${response.results.length}개 결과`, 'success');
        const container = document.getElementById('results');

        response.results.forEach(r => {
            const item = document.createElement('div');
            item.className = 'result-item';
            item.innerHTML = `
                <img src="https://img.youtube.com/vi/${r.videoId}/mqdefault.jpg"
                     style="width:100%;border-radius:7px;margin-bottom:7px;display:block;">
                <div class="result-title">${r.title}</div>
                <div class="result-snippet">${r.text}</div>
                <div class="result-score">유사도 ${(r.score * 100).toFixed(1)}%</div>
            `;
            // 검색 결과 클릭
            item.addEventListener('click', () => {
                const url = r.startTime != null
                    ? `https://www.youtube.com/watch?v=${r.videoId}&t=${r.startTime}`
                    : r.url;
                chrome.tabs.create({ url });
            });
            container.appendChild(item);
        });
    });
});

// ==================== 목록 토글 ====================
let listOpen = false;

const listBtn = document.getElementById('listBtn');
const listWrap = document.getElementById('videoListWrap');
const listChevron = document.getElementById('listChevron');

listBtn.addEventListener('click', async () => {
    listOpen = !listOpen;
    listWrap.classList.toggle('collapsed', !listOpen);
    listChevron.classList.toggle('open', listOpen);

    if (listOpen) {
        const tab = await getTab();
        loadVideoList(tab);
    }
});

// ==================== 목록 불러오기 ====================
function loadVideoList(tab) {
    const container = document.getElementById('videoList');
    const clearAllBtn = document.getElementById('clearAllBtn');
    container.innerHTML = '<div class="empty-msg">불러오는 중…</div>';

    chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEOS' }, (response) => {
        container.innerHTML = '';

        if (!response?.success) {
            container.innerHTML = '<div class="empty-msg">불러오기 실패</div>';
            clearAllBtn.style.display = 'none';
            updateBadge(0);
            return;
        }

        const videos = response.videos;
        updateBadge(videos.length);

        if (videos.length === 0) {
            container.innerHTML = '<div class="empty-msg">저장된 영상이 없습니다</div>';
            clearAllBtn.style.display = 'none';
            return;
        }

        clearAllBtn.style.display = 'block';

        videos.forEach(video => {
            container.appendChild(buildVideoItem(video, tab, container, clearAllBtn));
        });
    });
}

// ==================== 영상 아이템 생성 ====================
function buildVideoItem(video, tab, container, clearAllBtn) {
    const date = new Date(video.savedAt).toLocaleDateString('ko-KR');
    const item = document.createElement('div');
    item.className = 'video-item';
    item.innerHTML = `
        <img src="https://img.youtube.com/vi/${video.videoId}/mqdefault.jpg"
             style="width:72px;height:40px;object-fit:cover;border-radius:6px;flex-shrink:0;">
        <div class="video-info">
            <div class="video-item-title">${video.title}</div>
            <div class="video-item-date">${date}</div>
        </div>
        <div class="video-actions">
            <button class="icon-btn copy-btn" title="URL 복사">⎘</button>
            <button class="icon-btn delete-btn" title="삭제">✕</button>
        </div>
    `;

    // 제목 클릭 → 탭 열기
    item.querySelector('.video-info').addEventListener('click', () => {
        chrome.tabs.create({ url: video.url });
    });

    // URL 복사
    item.querySelector('.copy-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
            await navigator.clipboard.writeText(video.url);
            const btn = e.currentTarget;
            btn.classList.add('copied');
            btn.textContent = '✓';
            setTimeout(() => {
                btn.classList.remove('copied');
                btn.textContent = '⎘';
            }, 1200);
        } catch {
            setStatus('복사 실패', 'error');
        }
    });

    // 삭제
    item.querySelector('.delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.tabs.sendMessage(tab.id, { type: 'DELETE_VIDEO', videoId: video.videoId }, (res) => {
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
    const confirmed = confirm('저장된 영상을 모두 삭제할까요?');
    if (!confirmed) return;

    const tab = await getTab();
    const container = document.getElementById('videoList');
    const clearAllBtn = document.getElementById('clearAllBtn');

    chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_ALL_VIDEOS' }, (res) => {
        if (res?.success) {
            container.innerHTML = '<div class="empty-msg">저장된 영상이 없습니다</div>';
            clearAllBtn.style.display = 'none';
            updateBadge(0);
            setStatus('전체 삭제 완료', 'success');
        } else {
            setStatus('삭제 실패', 'error');
        }
    });
});