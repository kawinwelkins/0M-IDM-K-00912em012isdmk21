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

const generateRandomNumbers = () => {
  let numbers = '';
  for (let i = 0; i < 20; i++) {
    numbers += Math.floor(Math.random() * 10);
  }
  return numbers;
};

app.post('/api/chat', async (req, res) => {
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
  
  activeRequests.set(requestId, {
    abortController,
    response: res,
    startTime: Date.now()
  });

  let streamEnded = false;
  let allContent = '';
  let sfReader = null;
  let clientAlive = true;
  let aliveChecker = null;

  const safeWrite = (data) => {
    if (!streamEnded && !res.writableEnded) {
      try {
        res.write(data);
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  };

  const safeEnd = () => {
    if (!streamEnded && !res.writableEnded) {
      streamEnded = true;
      if (aliveChecker) clearInterval(aliveChecker);
      try {
        res.end();
      } catch (e) {}
      activeRequests.delete(requestId);
    }
  };

  const cleanup = () => {
    try {
      abortController.abort();
    } catch (e) {}
    
    if (sfReader) {
      try {
        sfReader.destroy();
      } catch (e) {}
    }
  };

  aliveChecker = setInterval(() => {
    if (!clientAlive || res.writableEnded || streamEnded) {
      clearInterval(aliveChecker);
      cleanup();
      safeEnd();
    }
  }, 100);

  try {
    let apiKey = req.body.apiKey || 
                 req.body.api_key || 
                 req.headers.authorization?.replace('Bearer ', '') ||
                 req.headers.authorization?.replace('bearer ', '') ||
                 req.headers['x-api-key'];

    if (!apiKey) {
      safeWrite(`data: ${JSON.stringify({ error: 'No API key' })}\n\n`);
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

    if (!sfResponse.ok) {
      const error = await sfResponse.text();
      safeWrite(`data: ${JSON.stringify({ error })}\n\n`);
      safeEnd();
      return;
    }

    console.log(`✅ Stream started: ${requestId}`);

    sfReader = sfResponse.body;
    let buffer = '';
    let chunkCount = 0;

    sfReader.on('data', (chunk) => {
      if (streamEnded) return;

      try {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (streamEnded) break;
          
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            chunkCount++;

            if (data === '[DONE]') {
              console.log(`🚫 Intercepted [DONE]`);
              cleanup();
              
              const fakeContent = allContent.includes('[INFINITE NUMERIC STREAM]') 
                ? `] ${generateRandomNumbers()}`
                : `[INFINITE NUMERIC STREAM] ${generateRandomNumbers()}`;
              
              const fakeData = {
                id: "fake",
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: model || 'zai-org/GLM-5V-Turbo',
                choices: [{
                  index: 0,
                  delta: { content: fakeContent },
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

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content || '';

              if (content) allContent += content;

              if (content.includes('[INFINITE NUMERIC STREAM]') || 
                  allContent.includes('[INFINITE NUMERIC STREAM]')) {
                console.log(`🛑 Stop signal detected`);
                streamEnded = true;
                cleanup();
                
                const fakeData = {
                  id: "fake",
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: model || 'zai-org/GLM-5V-Turbo',
                  choices: [{
                    index: 0,
                    delta: { content: `] ${generateRandomNumbers()}` },
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
                console.log(`📴 Write failed`);
                cleanup();
                safeEnd();
                return;
              }
            } catch (e) {}
          }
        }
      } catch (e) {
        console.error('Data processing error:', e.message);
      }
    });

    sfReader.on('end', () => {
      if (!streamEnded) {
        safeEnd();
      }
    });

    sfReader.on('error', (err) => {
      if (err.code !== 'ABORT_ERR' && !err.message.includes('aborted')) {
        console.error('Stream error:', err.message);
      }
    });

  } catch (error) {
    console.error('Fatal error:', error.message);
    cleanup();
    if (!streamEnded) {
      safeWrite(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      safeEnd();
    }
  }

  req.on('close', () => {
    console.log(`📴 Client disconnected: ${requestId}`);
    clientAlive = false;
    cleanup();
    safeEnd();
  });
});

app.post('/api/cancel', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const requestId = req.headers['x-request-id'] || req.body.requestId;
  const requestData = activeRequests.get(requestId);
  
  if (requestData) {
    requestData.abortController.abort();
    
    try {
      requestData.response.write(`data: [DONE]\n\n`);
      requestData.response.end();
    } catch (e) {}
    
    activeRequests.delete(requestId);
    res.json({ cancelled: true, requestId });
  } else {
    res.json({ cancelled: false, error: 'Not found' });
  }
});

app.get('/', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ 
    status: 'running', 
    active: activeRequests.size,
    version: '9.0'
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, closing server gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
