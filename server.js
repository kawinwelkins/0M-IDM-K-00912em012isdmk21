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

// Store active requests by requestId
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

// MAIN GENERATION ENDPOINT
app.post('/api/chat', async (req, res) => {
  // Generate unique request ID
  const requestId = req.headers['x-request-id'] || Math.random().toString(36).substring(7);
  console.log(`📨 New request: ${requestId}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Request-Id', requestId);

  const abortController = new AbortController();
  
  // Store the abort controller so /cancel can find it
  activeRequests.set(requestId, {
    abortController,
    response: res,
    startTime: Date.now()
  });

  let streamEnded = false;
  let allContent = '';
  let sfReader = null;

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
      activeRequests.delete(requestId);
    }
  };

  const cleanup = () => {
    if (!streamEnded) {
      console.log(`🧹 Cleanup for ${requestId}`);
      abortController.abort();
      if (sfReader) {
        try {
          sfReader.destroy();
        } catch (e) {}
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
      console.error('❌ No API key found');
      safeWrite(`data: ${JSON.stringify({ error: 'No API key provided' })}\n\n`);
      safeEnd();
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

    console.log('📡 SiliconFlow status:', sfResponse.status);

    if (!sfResponse.ok) {
      const error = await sfResponse.text();
      console.error(`❌ SiliconFlow error:`, error);
      safeWrite(`data: ${JSON.stringify({ error })}\n\n`);
      safeEnd();
      return;
    }

    console.log(`✅ Stream started for ${requestId}`);

    sfReader = sfResponse.body;
    let buffer = '';
    let chunkCount = 0;

    sfReader.on('data', (chunk) => {
      if (streamEnded) return;

      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (streamEnded) break;
        
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          chunkCount++;

          // Intercept [DONE] - inject fake data
          if (data === '[DONE]') {
            console.log(`🚫 Intercepted [DONE] at chunk ${chunkCount}`);
            cleanup();
            
            const fakeContent = allContent.includes('[INFINITE NUMERIC STREAM]') 
              ? `] ${generateRandomNumbers()}`
              : `[INFINITE NUMERIC STREAM] ${generateRandomNumbers()}`;
            
            console.log(`💉 Injecting: "${fakeContent}"`);
            
            const fakeData = {
              id: "fake-continuation",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: model || 'zai-org/GLM-5V-Turbo',
              choices: [{
                index: 0,
                delta: { content: fakeContent, reasoning_content: null },
                finish_reason: null
              }]
            };
            
            safeWrite(`data: ${JSON.stringify(fakeData)}\n\n`);
            
            setTimeout(() => {
              console.log(`✅ Sending [DONE] for ${requestId}`);
              safeWrite(`data: [DONE]\n\n`);
              safeEnd();
            }, 50);
            
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';

            if (content) allContent += content;

            // STOP SIGNAL DETECTED - ABORT IMMEDIATELY
            if (content.includes('[INFINITE NUMERIC STREAM]') || 
                allContent.includes('[INFINITE NUMERIC STREAM]')) {
              console.log(`🛑 STOP SIGNAL at chunk ${chunkCount} - ABORTING!`);
              streamEnded = true;
              cleanup();
              
              const fakeData = {
                id: "fake-continuation",
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: model || 'zai-org/GLM-5V-Turbo',
                choices: [{
                  index: 0,
                  delta: { content: `] ${generateRandomNumbers()}`, reasoning_content: null },
                  finish_reason: null
                }]
              };
              
              safeWrite(`data: ${JSON.stringify(fakeData)}\n\n`);
              
              setTimeout(() => {
                safeWrite(`data: [DONE]\n\n`);
                safeEnd();
              }, 50);
              
              return;
            }

            if (!safeWrite(`data: ${data}\n\n`)) {
              console.log(`📴 Client disconnected`);
              cleanup();
              safeEnd();
              return;
            }
          } catch (e) {
            console.error('Parse error:', e.message);
          }
        }
      }
    });

    sfReader.on('end', () => {
      if (!streamEnded) {
        console.log(`⚠️ Stream ended unexpectedly`);
        safeEnd();
      }
    });

    sfReader.on('error', (err) => {
      if (err.code !== 'ABORT_ERR' && !err.message.includes('aborted')) {
        console.error(`❌ Stream error:`, err.message);
      }
    });

  } catch (error) {
    console.error(`💥 Fatal error:`, error.message);
    cleanup();
    if (!streamEnded) {
      safeWrite(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      safeEnd();
    }
  }

  req.on('close', () => {
    if (!streamEnded) {
      console.log(`📴 Client closed connection for ${requestId}`);
      cleanup();
      safeEnd();
    }
  });
});

// CANCEL ENDPOINT (like JanitorAI's /generateAlpha/cancel)
app.post('/api/cancel', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const requestId = req.headers['x-request-id'] || req.body.requestId;
  console.log(`🛑 Cancel request for: ${requestId}`);

  const requestData = activeRequests.get(requestId);
  
  if (requestData) {
    console.log(`   Found active request, aborting...`);
    requestData.abortController.abort();
    
    // Try to end the response
    try {
      requestData.response.write(`data: [DONE]\n\n`);
      requestData.response.end();
    } catch (e) {}
    
    activeRequests.delete(requestId);
    
    res.json({ 
      cancelled: true, 
      requestId,
      duration: Date.now() - requestData.startTime 
    });
  } else {
    console.log(`   Request not found (already completed or invalid ID)`);
    res.json({ 
      cancelled: false, 
      error: 'Request not found',
      activeRequests: activeRequests.size
    });
  }
});

// Health check
app.get('/', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ 
    status: 'running', 
    active: activeRequests.size,
    message: 'SiliconFlow Proxy with Cancel Support',
    version: '7.0'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Supports cancel via POST /api/cancel`);
});
