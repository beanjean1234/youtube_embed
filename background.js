// ==================== IndexedDB (Background) ====================
function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('yt-memory-ext', 1);
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

function saveVideo(db, videoId, url, title) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('videos', 'readwrite');
        tx.objectStore('videos').put({ videoId, url, title, savedAt: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

function saveChunks(db, chunks) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('chunks', 'readwrite');
        const store = tx.objectStore('chunks');
        chunks.forEach(chunk => store.add(chunk));
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

function getAllChunks(db) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('chunks', 'readonly');
        const req = tx.objectStore('chunks').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// ==================== 설정 로드 ====================
function loadSettings() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['geminiApiKey'], (data) => {
            resolve({ apiKey: data.geminiApiKey || '' });
        });
    });
}

// ==================== 임베딩 API 호출 ====================
async function getEmbedding(text) {
    const { apiKey } = await loadSettings();
    if (!apiKey) throw new Error('API Key가 설정되지 않았습니다.');

    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: `models/gemini-embedding-2`,
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

// ==================== 코사인 유사도 ====================
function cosineSimilarity(a, b) {
    const dot   = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    return dot / (normA * normB);
}

// ==================== 메시지 리스너 ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    
    // --- (1) 저장 (Content Script에서 추출 후 전달) ---
    if (message.type === 'SAVE_EMBEDDINGS') {
        (async () => {
            try {
                const db = await openDB();
                await saveVideo(db, message.videoId, message.url, message.title);
                await saveChunks(db, message.chunks);
                sendResponse({ success: true, saved: message.chunks.length });
            } catch (err) {
                console.error('[SAVE_EMBEDDINGS 오류]', err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true; 
    }

    // --- (2) 검색 (Popup에서 요청) ---
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

    // --- (3) 목록 조회 ---
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

    // --- (4) 단일 영상 삭제 ---
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

    // --- (5) 전체 영상 삭제 ---
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

});
