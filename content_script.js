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

// ==================== 청킹 ====================
function makeChunks(texts, videoId, chunkSize = 20) {
    const chunks = [];
    for (let i = 0; i < texts.length; i += chunkSize) {
        const slice = texts.slice(i, i + chunkSize);
        chunks.push({
            videoId,
            text: slice.join(' '),
            index: Math.floor(i / chunkSize),
        });
    }
    return chunks;
}

// ==================== 설정 로드 ====================
function loadSettings() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['embeddingModel', 'embeddingApiKey'], (data) => {
            resolve({
                model:  data.embeddingModel  ?? 'openai::text-embedding-3-small',
                apiKey: data.embeddingApiKey ?? '',
            });
        });
    });
}

// ==================== 임베딩 API 호출 ====================
async function getEmbedding(text) {
    const { model, apiKey } = await loadSettings();

    if (!apiKey) {
        throw new Error('API Key가 설정되지 않았습니다. 팝업의 ⚙ 설정에서 API Key를 입력해 주세요.');
    }

    // model 값 형식: "provider::modelName"
    const [provider, modelName] = model.split('::');

    // ── OpenAI ──
    if (provider === 'openai') {
        const res = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                input: text,
                model: modelName,
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`OpenAI 오류: ${err?.error?.message ?? res.statusText}`);
        }

        const data = await res.json();
        return data.data[0].embedding;
    }

    // ── Google Generative Language ──
    if (provider === 'google') {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:embedContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: `models/${modelName}`,
                    content: { parts: [{ text }] },
                }),
            }
        );

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`Google 오류: ${err?.error?.message ?? res.statusText}`);
        }

        const data = await res.json();
        return data.embedding.values;
    }

    throw new Error(`알 수 없는 provider: ${provider}`);
}

// ==================== 코사인 유사도 ====================
function cosineSimilarity(a, b) {
    const dot   = a.reduce((sum, val, i) => sum + val * b[i], 0);
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

                const url     = window.location.href;
                const videoId = new URLSearchParams(window.location.search).get('v');
                const title   = document.querySelector('h1.ytd-video-primary-info-renderer')?.textContent?.trim()
                              || document.title;

                const rawChunks = makeChunks(texts, videoId);
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
                    const tx  = db.transaction('videos', 'readonly');
                    const req = tx.objectStore('videos').getAll();
                    req.onsuccess = () => resolve(req.result);
                    req.onerror   = () => reject(req.error);
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
                    tx.onerror    = () => reject(tx.error);
                });
                await new Promise((resolve, reject) => {
                    const tx    = db.transaction('chunks', 'readwrite');
                    const index = tx.objectStore('chunks').index('videoId');
                    const range = IDBKeyRange.only(message.videoId);
                    index.openCursor(range).onsuccess = (e) => {
                        const cursor = e.target.result;
                        if (cursor) { cursor.delete(); cursor.continue(); }
                    };
                    tx.oncomplete = resolve;
                    tx.onerror    = () => reject(tx.error);
                });
                sendResponse({ success: true });
            } catch (err) {
                console.error('[DELETE_VIDEO 오류]', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    // --- 전체 영상 삭제 ---
    if (message.type === 'CLEAR_ALL_VIDEOS') {
        (async () => {
            try {
                const db = await openDB();
                await new Promise((resolve, reject) => {
                    const tx = db.transaction('videos', 'readwrite');
                    tx.objectStore('videos').clear();
                    tx.oncomplete = resolve;
                    tx.onerror    = () => reject(tx.error);
                });
                await new Promise((resolve, reject) => {
                    const tx = db.transaction('chunks', 'readwrite');
                    tx.objectStore('chunks').clear();
                    tx.oncomplete = resolve;
                    tx.onerror    = () => reject(tx.error);
                });
                sendResponse({ success: true });
            } catch (err) {
                console.error('[CLEAR_ALL_VIDEOS 오류]', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

}); // ← 리스너 닫는 괄호
