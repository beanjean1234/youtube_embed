// ==================== IndexedDB ====================
function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('yt-memory', 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('videos')) {
                db.createObjectStore('videos', { keyPath: 'videoId' });
            }
            if (!db.objectStoreNames.contains('chunks')) {
                const store = db.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
                store.createIndex('videoId', 'videoId');
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = () => reject(req.error);
    });
}

async function saveVideo(db, videoId, url, title) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('videos', 'readwrite');
        tx.objectStore('videos').put({ videoId, url, title, savedAt: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

async function saveChunks(db, chunks) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('chunks', 'readwrite');
        const store = tx.objectStore('chunks');
        chunks.forEach(chunk => store.add(chunk));
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

async function getAllChunks(db) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('chunks', 'readonly');
        const req = tx.objectStore('chunks').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// ==================== 청킹 (정밀도 향상 버전) ====================
function makeChunks(texts, videoId, chunkSize = 10, overlapSize = 5) {
    const chunks = [];
    const step = chunkSize - overlapSize; // 다음 청크까지 이동할 거리

    for (let i = 0; i < texts.length; i += step) {
        const slice = texts.slice(i, i + chunkSize);

        // 최소한의 의미를 가질 수 있도록 3줄 이하의 너무 짧은 조각은 건너뜀 (마지막 부분)
        if (slice.length < 3 && i !== 0) break;

        chunks.push({
            videoId,
            text: slice.join(' '),
            index: Math.floor(i / step),
        });

        // 원본 데이터 끝에 도달하면 종료
        if (i + chunkSize >= texts.length) break;
    }
    return chunks;
}

// ==================== 설정 로드 ====================
function loadSettings() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['embeddingModel', 'embeddingApiKey'], (data) => {
            resolve({
                model: data.embeddingModel ?? 'google::text-embedding-004',
                apiKey: data.embeddingApiKey ?? '',
            });
        });
    });
}

// ==================== Gemini 요약 분석 API (1.5 Flash) ====================
async function summarizeText(text) {
    const { apiKey } = await loadSettings();
    if (!apiKey) throw new Error('Gemini API Key가 필요합니다.');

    // 최상위 수준의 상세 분석 지시문 (고정)
    const promptInstruction = `다음 유튜브 쇼츠 자막을 아주 상세하게 분석해줘. 
내용은 검색에 최적화되도록 다음 요소들을 포함해서 5~6문장 내외로 작성해줘:
1. 영상의 전반적인 분위기와 말하는 이의 명확한 의도
2. 언급된 핵심 주장, 사실 관계 및 구체적인 정보
3. 영상에서 강조된 특별한 하이라이트나 결론
4. 검색 색인 완성도를 높이기 위한 관련 키워드 및 태그 10개 이상`;

    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: `${promptInstruction}\n\n[자막 내용]:\n${text}` }]
                }]
            }),
        }
    );

    if (!res.ok) {
        throw new Error('요약 생성 중 오류가 발생했습니다.');
    }

    const data = await res.json();
    return data.candidates[0].content.parts[0].text;
}

// ==================== 임베딩 API 호출 (Gemini 전용) ====================
async function getEmbedding(text) {
    const { model, apiKey } = await loadSettings();

    if (!apiKey) {
        throw new Error('Gemini API Key가 설정되지 않았습니다. 팝업 설정에서 API Key를 입력해 주세요.');
    }

    // model 값 형식: "google::modelName"
    let [provider, modelName] = model.split('::');


    if (provider !== 'google') {
        throw new Error(`지원되지 않는 모델 형식입니다: ${provider}`);
    }

    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:embedContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                taskType: "RETRIEVAL_DOCUMENT",
                content: { parts: [{ text }] },
            }),
        }
    );

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`Google Gemini 오류: ${err?.error?.message ?? res.statusText}`);
    }

    const data = await res.json();
    return data.embedding.values;
}

// ==================== 코사인 유사도 ====================
function cosineSimilarity(a, b) {
    const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    return dot / (normA * normB);
}

// ==================== 메시지 리스너 ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // --- 스크립트 추출 & 저장 ---
    if (message.type === 'EXTRACT_TEXTS') {

        const panel = document.querySelector(
            'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
        );

        if (!panel) {
            sendResponse({ success: false, error: '스크립트 패널을 못 찾았습니다.' });
            return true;
        }

        panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');

        setTimeout(async () => {
            try {
                const segments = panel.querySelectorAll('yt-formatted-string.segment-text');
                const texts = Array.from(segments)
                    .map(el => el.textContent.trim())
                    .filter(Boolean);

                panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');

                if (texts.length === 0) {
                    sendResponse({ success: false, error: '스크립트를 찾지 못하였습니다.' });
                    return;
                }

                const url = window.location.href;
                const isShort = url.includes('/shorts/');
                const videoId = isShort
                    ? url.split('/shorts/')[1].split('?')[0] // 쇼츠용 ID 추출
                    : new URLSearchParams(window.location.search).get('v');

                const title = document.querySelector('h1.ytd-video-primary-info-renderer')?.textContent?.trim()
                    || document.title;

                // ── 쇼츠 특화 로직: AI 요약 추가 ──
                let processedTexts = [...texts];
                if (isShort) {
                    console.log("[YT Memory] Shorts detected. Analyzing with Gemini 1.5 Flash...");
                    try {
                        const fullScript = texts.join(' ');
                        const summary = await summarizeText(fullScript);
                        processedTexts = [`[AI Context: ${summary}]`, ...texts];
                    } catch (e) {
                        console.error("Summary failed, continuing with raw script", e);
                    }
                }

                // ── 청크 생성 ──
                const chunkSize = isShort ? 7 : 10;
                const overlap = isShort ? 4 : 5;
                const rawChunks = makeChunks(processedTexts, videoId, chunkSize, overlap);

                const db = await openDB();
                await saveVideo(db, videoId, url, title);

                const embeddedChunks = [];
                for (const chunk of rawChunks) {
                    const embedding = await getEmbedding(chunk.text);
                    embeddedChunks.push({ ...chunk, embedding, url, title });
                }

                await saveChunks(db, embeddedChunks);
                sendResponse({ success: true, saved: embeddedChunks.length });

            } catch (err) {
                console.error('[EXTRACT_TEXTS 오류]', err);
                sendResponse({ success: false, error: err.message });
            }
        }, 1500);

        return true;
    }

    // --- 검색 ---
    if (message.type === 'SEARCH') {
        (async () => {
            try {
                const queryEmbedding = await getEmbedding(message.query);
                const db = await openDB();
                const allChunks = await getAllChunks(db);

                const scored = allChunks
                    .map(chunk => ({
                        ...chunk,
                        score: cosineSimilarity(queryEmbedding, chunk.embedding),
                    }))
                    .sort((a, b) => b.score - a.score)
                    .filter((chunk, index, arr) =>
                        arr.findIndex(c => c.videoId === chunk.videoId) === index
                    )
                    .slice(0, 5);

                sendResponse({ success: true, results: scored });

            } catch (err) {
                console.error('[SEARCH 오류]', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    // --- 저장된 영상 목록 조회 ---
    if (message.type === 'GET_VIDEOS') {
        (async () => {
            try {
                const db = await openDB();
                const videos = await new Promise((resolve, reject) => {
                    const tx = db.transaction('videos', 'readonly');
                    const req = tx.objectStore('videos').getAll();
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });
                videos.sort((a, b) => b.savedAt - a.savedAt);
                sendResponse({ success: true, videos });
            } catch (err) {
                console.error('[GET_VIDEOS 오류]', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    // --- 특정 영상 삭제 ---
    if (message.type === 'DELETE_VIDEO') {
        (async () => {
            try {
                const db = await openDB();
                await new Promise((resolve, reject) => {
                    const tx = db.transaction('videos', 'readwrite');
                    tx.objectStore('videos').delete(message.videoId);
                    tx.oncomplete = resolve;
                    tx.onerror = () => reject(tx.error);
                });
                await new Promise((resolve, reject) => {
                    const tx = db.transaction('chunks', 'readwrite');
                    const index = tx.objectStore('chunks').index('videoId');
                    const range = IDBKeyRange.only(message.videoId);
                    index.openCursor(range).onsuccess = (e) => {
                        const cursor = e.target.result;
                        if (cursor) { cursor.delete(); cursor.continue(); }
                    };
                    tx.oncomplete = resolve;
                    tx.onerror = () => reject(tx.error);
                });
                sendResponse({ success: true });
            } catch (err) {
                console.error('[DELETE_VIDEO 오류]', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    // --- 전체 영상 삭제 (강력한 초기화 버전) ---
    if (message.type === 'CLEAR_ALL_VIDEOS') {
        (async () => {
            try {
                // 1. 기존 데이터베이스 연결 시도 및 종료
                // (열려있는 연결이 있으면 삭제가 안 될 수 있으므로 close 시도)
                try {
                    const db = await openDB();
                    db.close();
                } catch (e) {
                    // 이미 DB가 깨져있어서 못 열 수도 있으므로 여기 에러는 무시
                }

                // 2. 데이터베이스 자체를 완전히 삭제
                await new Promise((resolve, reject) => {
                    const req = indexedDB.deleteDatabase('yt-memory');
                    req.onsuccess = () => {
                        console.log('[YT Memory] Database deleted successfully.');
                        resolve();
                    };
                    req.onerror = (e) => reject(new Error('DB 삭제 실패: ' + e.target.error));
                    req.onblocked = () => {
                        // 다른 탭에서 DB를 열고 있을 때 발생. 사용자에게 안내가 필요할 수 있음.
                        console.warn('[YT Memory] Delete blocked. Please close other YouTube tabs.');
                        resolve(); // 일단 진행 시도
                    };
                });

                // 3. 다시 빈 DB를 열어서 스키마 초기화 (openDB가 내부적으로 upgradeneeded 발생시킴)
                await openDB();

                sendResponse({ success: true });
            } catch (err) {
                console.error('[CLEAR_ALL_VIDEOS 오류]', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

}); // ← 리스너 닫는 괄호
