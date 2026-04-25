// ==================== 설정 로드 ====================
function loadSettings() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['geminiApiKey'], (data) => {
            resolve({ apiKey: data.geminiApiKey || '' });
        });
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



// ==================== [신규] 배치 임베딩 API 호출 ====================
async function getBatchEmbeddings(texts) {
    const { apiKey } = await loadSettings();
    if (!apiKey) throw new Error('API Key가 없습니다.');

    // 텍스트 조각들을 API 형식에 맞게 변환
    const requests = texts.map(text => ({
        model: `models/gemini-embedding-2`,
        content: { parts: [{ text }] }
    }));

    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests })
        }
    );

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`Batch 임베딩 오류: ${err?.error?.message ?? res.statusText}`);
    }

    const data = await res.json();
    // 결과값만 추출해서 반환
    return data.embeddings.map(e => e.values);
}

// ==================== Shorts 분석 API 호출 ====================
async function analyzeShortsWithGemini(url, apiKey) {
    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [
                    {
                        role: 'user',
                        parts: [{ text: `다음 YouTube Shorts 영상을 상세하게 분석하고 내용을 설명해 줘. URL: ${url}` }]
                    }
                ]
            })
        }
    );

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`Shorts 분석 오류: ${err?.error?.message ?? res.statusText}`);
    }

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}



// ==================== 메시지 리스너 ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // --- 스크립트 추출 & 저장 ---
    if (message.type === 'EXTRACT_TEXTS') {
        const url = window.location.href;

        // 1. Shorts 영상 분기 처리
        if (url.includes('/shorts/')) {
            (async () => {
                try {
                    const videoId = url.split('/shorts/')[1].split(/[?#]/)[0];
                    const title = document.title;
                    const { apiKey } = await loadSettings();

                    if (!apiKey) throw new Error('API Key가 설정되지 않았습니다.');

                    const analysisText = await analyzeShortsWithGemini(url, apiKey);
                    if (!analysisText) {
                        sendResponse({ success: false, error: 'Shorts 분석 결과를 가져오지 못했습니다.' });
                        return;
                    }

                    const lines = analysisText.split('\n').filter(l => l.trim() !== '');
                    const rawChunks = makeChunks(lines, videoId, 5, 2);
                    
                    // --- [개선] 배치 임베딩 적용 ---
                    const embeddings = await getBatchEmbeddings(rawChunks.map(c => c.text));
                    const embeddedChunks = rawChunks.map((chunk, i) => ({
                        ...chunk,
                        embedding: embeddings[i],
                        url,
                        title
                    }));

                    // 백그라운드 스크립트로 전송하여 저장
                    chrome.runtime.sendMessage({
                        type: 'SAVE_EMBEDDINGS',
                        videoId,
                        url,
                        title,
                        chunks: embeddedChunks
                    }, (response) => {
                        sendResponse(response);
                    });

                } catch (err) {
                    console.error('[SHORTS EXTRACT 오류]', err);
                    sendResponse({ success: false, error: err.message });
                }
            })();
            return true;
        }

        // 2. 일반 영상 스크립트 추출 로직
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
                // --- [개선] 배치 임베딩 적용 ---
                const embeddings = await getBatchEmbeddings(rawChunks.map(c => c.text));
                const embeddedChunks = rawChunks.map((chunk, i) => ({
                    ...chunk,
                    embedding: embeddings[i],
                    url,
                    title
                }));

                // 백그라운드 스크립트로 전송하여 저장
                chrome.runtime.sendMessage({
                    type: 'SAVE_EMBEDDINGS',
                    videoId,
                    url,
                    title,
                    chunks: embeddedChunks
                }, (response) => {
                    sendResponse(response);
                });

            } catch (err) {
                console.error('[EXTRACT_TEXTS 오류]', err);
                sendResponse({ success: false, error: err.message });
            }
        }, 1500);

        return true;
    }



}); // ← 리스너 닫는 괄호
