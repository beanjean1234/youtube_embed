// ==================== CONFIG ====================
// Vercel API 호스팅 주소입니다.
const VERCEL_EMBED_API_URL = 'https://youtube-embed-api.vercel.app/api/embed';

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

// ==================== Vercel 임베딩 서버 호출 ====================
async function getEmbedding(text) {
    const res = await fetch(VERCEL_EMBED_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            text: text,
        }),
    });

    if (!res.ok) {
        throw new Error('Vercel 서버에서 임베딩을 가져오는데 실패했습니다.');
    }

    const data = await res.json();
    // Vercel 서버에서 { embedding: [...] } 형태로 반환한다고 가정합니다.
    return data.embedding;
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

    if (message.type === 'EXTRACT_TEXTS') {

        const panel = document.querySelector(
            'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
        );

        if (!panel) {
            sendResponse({ success: false, error: '스크립트 패널을 못 찾았습니다.' }); // ← 수정
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

                // 청크가 0개면 저장 안 하고 종료
                if (texts.length === 0) {
                    sendResponse({ success: false, error: '스크립트를 찾지 못하였습니다.' }); // ← 추가
                    return;
                }

                const url = window.location.href;
                const videoId = new URLSearchParams(window.location.search).get('v');
                const title = document.querySelector('h1.ytd-video-primary-info-renderer')?.textContent?.trim()
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
    // --- 전체 영상 삭제 ---
    if (message.type === 'CLEAR_ALL_VIDEOS') {
        (async () => {
            try {
                const db = await openDB();
                await new Promise((resolve, reject) => {
                    const tx = db.transaction('videos', 'readwrite');
                    tx.objectStore('videos').clear();
                    tx.oncomplete = resolve;
                    tx.onerror = () => reject(tx.error);
                });
                await new Promise((resolve, reject) => {
                    const tx = db.transaction('chunks', 'readwrite');
                    tx.objectStore('chunks').clear();
                    tx.oncomplete = resolve;
                    tx.onerror = () => reject(tx.error);
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
