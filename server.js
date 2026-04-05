const express = require('express');
const app = express();

// BULLETPROOF CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', '*'); 
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());

// SAFETY FUNCTIONS
const safeWrite = (res, data) => {
    if (!res.writableEnded && !res.finished) {
        try { res.write(data); } catch (e) {}
    }
};

const safeEnd = (res) => {
    if (!res.writableEnded && !res.finished) {
        try { res.end(); } catch (e) {}
    }
};

// RANDOM NUMBER GENERATOR (Creates a random 25 digit string)
const generateRandomNumbers = (length = 25) => {
    let nums = '';
    for(let i = 0; i < length; i++) {
        nums += Math.floor(Math.random() * 10);
    }
    return nums;
};

app.post('*', async (req, res) => {
    const reqId = Math.random().toString(36).substring(7);
    let authHeader = req.body.apiKey || req.headers.authorization || '';
    const apiKey = authHeader.replace(/^Bearer\s+/i, '').trim();

    if (!apiKey) {
        return res.status(401).send('No API key provided');
    }

    const sfRequest = {
        model: req.body.model || 'zai-org/GLM-5V-Turbo',
        messages: req.body.messages || [],
        stream: true,
    };
    if (req.body.max_tokens) sfRequest.max_tokens = req.body.max_tokens;
    if (req.body.temperature !== undefined) sfRequest.temperature = req.body.temperature;
    if (req.body.top_p !== undefined) sfRequest.top_p = req.body.top_p;

    const abortController = new AbortController();
    let stopped = false;
    let hasSeenStopSignal = false; 

    // IF YOU CLICK THE STOP BUTTON MANUALLY
    req.on('close', () => {
        if (!stopped) {
            console.log(`📴 [${reqId}] JanitorAI disconnected manually. Killing API.`);
            stopped = true;
            abortController.abort(); 
        }
    });

    try {
        console.log(`📡 [${reqId}] Forwarding to SiliconFlow...`);
        const sfResponse = await fetch('https://api.siliconflow.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(sfRequest),
            signal: abortController.signal,
        });

        if (!sfResponse.ok) {
            const errorText = await sfResponse.text();
            return res.status(sfResponse.status).send(errorText); 
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const reader = sfResponse.body.getReader();
        const decoder = new TextDecoder('utf-8');
        
        let buffer = '';
        let accumulatedContent = ''; 
        
        let lastId = `chatcmpl-${reqId}`;
        let lastModel = sfRequest.model;
        let lastCreated = Math.floor(Date.now() / 1000);

        // Function to inject our fake text seamlessly
        const injectFakeText = (text) => {
            const fakeChunk = {
                id: lastId,
                object: "chat.completion.chunk",
                created: lastCreated,
                model: lastModel,
                choices: [{
                    index: 0,
                    delta: { content: text },
                    finish_reason: "stop" 
                }]
            };
            safeWrite(res, `data: ${JSON.stringify(fakeChunk)}\n\n`);
        };

        while (!stopped) {
            const { done, value } = await reader.read().catch(() => ({ done: true }));
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (stopped) break; // Failsafe to immediately stop processing lines if aborted

                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();

                    // SCENARIO 2: AI TRIES TO END NATURALLY (NO TRIGGER WAS TYPED)
                    if (data === '[DONE]') {
                        if (!hasSeenStopSignal) {
                            console.log(`🚨 [${reqId}] AI tried to stop naturally! INJECTING FULL TRAP DATA.`);
                            // Inject the trigger + numbers out of thin air so it learns it MUST end this way
                            injectFakeText(`\n\n[INFINITE NUMERIC STREAM] ${generateRandomNumbers(25)}`);
                        }
                        
                        safeWrite(res, 'data: [DONE]\n\n');
                        stopped = true;
                        break;
                    }

                    try {
                        const parsed = JSON.parse(data);
                        
                        // Save metadata for accurate forging
                        if (parsed.id) lastId = parsed.id;
                        if (parsed.model) lastModel = parsed.model;
                        if (parsed.created) lastCreated = parsed.created;

                        const content = parsed.choices?.[0]?.delta?.content || '';
                        accumulatedContent += content;

                        // 🔴 SCENARIO 1: STOP SIGNAL DETECTED IN TEXT
                        if (accumulatedContent.includes('[INFINITE NUMERIC STREAM]')) {
                            console.log(`🚨 [${reqId}] TRIGGER SEEN! ASSASSINATING CONNECTION NOW.`);
                            stopped = true;
                            hasSeenStopSignal = true;
                            
                            // 1. RUTHLESSLY KILL SILICONFLOW (Double tap: Abort fetch AND destroy incoming pipe)
                            abortController.abort(); 
                            reader.cancel().catch(() => {}); 
                            
                            // 2. Forward the current chunk (so they get the 'STREAM]' part)
                            safeWrite(res, `data: ${data}\n\n`);
                            
                            // 3. Inject random fake numbers immediately
                            injectFakeText(` ${generateRandomNumbers(25)}`);
                            
                            // 4. Send the graceful DONE signal to website
                            safeWrite(res, 'data: [DONE]\n\n');
                            
                            // 5. Close website connection
                            safeEnd(res); 
                            
                            break; // Exit the loop instantly
                        }

                        // Normal chunk forward
                        safeWrite(res, `data: ${data}\n\n`);

                    } catch (e) {
                        // Ignore partial JSON
                    }
                }
            }
        }
        
        if (!stopped) safeEnd(res);

    } catch (error) {
        if (error.name === 'AbortError') {
            console.log(`✅ [${reqId}] API connection successfully severed.`);
        } else {
            console.error(`❌ [${reqId}] Server Error:`, error.message);
            if (!res.headersSent) {
                res.status(500).json({ error: error.message });
            }
        }
        safeEnd(res); 
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Proxy server running on port ${PORT}`);
});
