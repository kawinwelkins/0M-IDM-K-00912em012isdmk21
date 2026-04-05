const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();

app.use(cors({
  origin: '*',
  credentials: false,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id']
}));

app.use(express.json());

const PORT = process.env.PORT || 3000;
const activeRequests = new Map();

app.options('*', cors());

// Generate random numbers
const generateRandomNumbers = () => {
  let numbers = '';
  for (let i = 0; i < 20; i++) {
    numbers += Math.floor(Math.random() * 10);
  }
  return numbers;
};

app.post('/api/chat', async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);
  console.log(`📨 New request: ${requestId}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Request-Id', requestId);

  const abortController = new AbortController();
  activeRequests.set(requestId, abortController);
  
  let streamEnded = false;
  let allContent = '';

  const safeWrite = (data) => {
    if (!streamEnded && !res.writableEnded) {
      try {
        res.write(data);
        return true;
      } catch (e) {
        console.log(`⚠️ Write failed for ${requestId}:`, e.message);
        return false;
      }
    }
    return false;
  };

  const safeEnd = () => {
    if (!streamEnded && !res.writableEnded) {
      streamEnded = true;
      try {
        res.end();
      } catch (e) {
        console.log(`⚠️ End failed for ${requestId}:`, e.message);
      }
    }
  };

  try {
    let apiKey = req.body.apiKey || 
                 req.body.api_key || 
                 req.headers.authorization?.replace('Bearer ', '') ||
                 req.headers.authorization?.replace('bearer ', '') ||
                 req.headers['x-api-key'];

    if (!apiKey) {
      console.error('❌ No API key found in request');
      safeWrite(`data: ${JSON.stringify({ error: 'No API key provided' })}\n\n`);
      safeEnd();
      activeRequests.delete(requestId);
      return;
    }

    const { model, messages, max_tokens, temperature, top_p } = req.body;

    const sfResponse = await fetch('https://api.siliconflow.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || 'zai-org/GLM-5V-Turbo',
        messages: messages || [],
        stream: true,
        max_tokens: max_tokens,
        temperature: temperature,
        top_p: top_p,
      }),
      signal: abortController.signal,
    });

    console.log('📡 SiliconFlow response status:', sfResponse.status);

    if (!sfResponse.ok) {
      const error = await sfResponse.text();
      console.error(`❌ SiliconFlow error (${sfResponse.status}):`, error);
      safeWrite(`data: ${JSON.stringify({ 
        error: `SiliconFlow API Error (${sfResponse.status})`,
        details: error 
      })}\n\n`);
      safeEnd();
      activeRequests.delete(requestId);
      return;
    }

    console.log(`✅ Stream started for ${requestId}`);

    const reader = sfResponse.body;
    let buffer = '';
    let chunkCount = 0;

    reader.on('data', (chunk) => {
      if (streamEnded) return;

      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (streamEnded) break;
        
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          chunkCount++;

          // 🔴 INTERCEPT [DONE] - Inject fake data if no stop signal was seen
          if (data === '[DONE]') {
            console.log(`🚫 Intercepted [DONE] at chunk ${chunkCount} - no stop signal was found`);
            console.log(`💉 Injecting fake stop signal + numbers`);
            
            // Abort SiliconFlow
            abortController.abort();
            reader.destroy();
            
            // Inject fake stop signal + numbers
            const fakeData = {
              id: "fake-continuation",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: model || 'zai-org/GLM-5V-Turbo',
              choices: [{
                index: 0,
                delta: {
                  content: `[INFINITE NUMERIC STREAM] ${generateRandomNumbers()}`,
                  reasoning_content: null
                },
                finish_reason: null
              }]
            };
            
            safeWrite(`data: ${JSON.stringify(fakeData)}\n\n`);
            
            setTimeout(() => {
              console.log(`✅ Sending [DONE] for ${requestId}`);
              safeWrite(`data: [DONE]\n\n`);
              safeEnd();
              activeRequests.delete(requestId);
            }, 50);
            
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';

            if (content) allContent += content;

            // 🔴 STOP SIGNAL DETECTED - HANG UP IMMEDIATELY!
            if (content.includes('[INFINITE NUMERIC STREAM]') || 
                allContent.includes('[INFINITE NUMERIC STREAM]')) {
              console.log(`🛑 STOP SIGNAL DETECTED at chunk ${chunkCount} - HANGING UP NOW!`);
              streamEnded = true;
              
              // 1. ABORT SILICONFLOW IMMEDIATELY
              console.log(`📞 Aborting SiliconFlow connection...`);
              abortController.abort();
              reader.destroy();
              
              // 2. Inject fake numbers (stop signal already in real response)
              console.log(`💉 Injecting fake numbers: ] ${generateRandomNumbers()}`);
              const fakeData = {
                id: "fake-continuation",
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: model || 'zai-org/GLM-5V-Turbo',
                choices: [{
                  index: 0,
                  delta: {
                    content: `] ${generateRandomNumbers()}`,
                    reasoning_content: null
                  },
                  finish_reason: null
                }]
              };
              
              safeWrite(`data: ${JSON.stringify(fakeData)}\n\n`);
              
              // 3. Send [DONE]
              setTimeout(() => {
                console.log(`✅ Sending [DONE] for ${requestId} (stopped at signal)`);
                safeWrite(`data: [DONE]\n\n`);
                safeEnd();
                activeRequests.delete(requestId);
              }, 50);
              
              return; // STOP PROCESSING IMMEDIATELY
            }

            // Forward real chunk
            if (!safeWrite(`data: ${data}\n\n`)) {
              console.log(`📴 Client disconnected during write`);
              streamEnded = true;
              abortController.abort();
              reader.destroy();
              activeRequests.delete(requestId);
              return;
            }
          } catch (e) {
            console.error('Parse error:', e.message);
          }
        }
      }
    });

    reader.on('end', () => {
      if (!streamEnded) {
        console.log(`⚠️ Stream ended without [DONE] - injecting fake stop signal`);
        
        const fakeData = {
          id: "fake-continuation",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: model || 'zai-org/GLM-5V-Turbo',
          choices: [{
            index: 0,
            delta: {
              content: `[INFINITE NUMERIC STREAM] ${generateRandomNumbers()}`,
              reasoning_content: null
            },
            finish_reason: null
          }]
        };
        
        safeWrite(`data: ${JSON.stringify(fakeData)}\n\n`);
        
        setTimeout(() => {
          safeWrite(`data: [DONE]\n\n`);
          safeEnd();
          activeRequests.delete(requestId);
        }, 50);
      }
    });

    reader.on('error', (err) => {
      if (err.code === 'ABORT_ERR' || err.message.includes('aborted')) {
        console.log(`✅ SiliconFlow connection aborted successfully`);
      } else {
        console.error(`❌ Stream error:`, err.message);
      }
    });

  } catch (error) {
    console.error(`💥 Fatal error for ${requestId}:`, error.message);
    if (!streamEnded) {
      safeWrite(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      safeEnd();
    }
    activeRequests.delete(requestId);
  }

  req.on('close', () => {
    if (!streamEnded) {
      console.log(`📴 Client disconnected: ${requestId}`);
      streamEnded = true;
      const controller = activeRequests.get(requestId);
      if (controller) {
        controller.abort();
        activeRequests.delete(requestId);
      }
    }
  });
});

app.post('/api/cancel', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const { requestId } = req.body;
  console.log(`🛑 Cancel request for: ${requestId}`);

  const controller = activeRequests.get(requestId);
  if (controller) {
    controller.abort();
    activeRequests.delete(requestId);
    res.json({ cancelled: true });
  } else {
    res.json({ cancelled: false, error: 'Request not found' });
  }
});

app.get('/', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ 
    status: 'running', 
    active: activeRequests.size,
    message: 'SiliconFlow Proxy - Stops IMMEDIATELY on signal!',
    version: '6.0'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Hangs up on SiliconFlow THE MOMENT stop signal is seen!`);
});
