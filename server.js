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
  let foundStopSignal = false;

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

  const injectFakeDataAndEnd = (reason, model) => {
    console.log(`💉 Injecting fake data for ${requestId} (reason: ${reason})`);
    
    // Abort SiliconFlow
    abortController.abort();
    
    let fakeContent;
    
    if (foundStopSignal) {
      // Stop signal was found, just add random numbers
      fakeContent = `] ${generateRandomNumbers()}`;
      console.log(`   ✅ Stop signal found - injecting: "${fakeContent}"`);
    } else {
      // No stop signal, inject the full stop signal + numbers
      fakeContent = `[INFINITE NUMERIC STREAM] ${generateRandomNumbers()}`;
      console.log(`   ⚠️ No stop signal - injecting: "${fakeContent}"`);
    }
    
    const fakeData = {
      id: "fake-continuation",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: model || 'zai-org/GLM-5V-Turbo',
      choices: [{
        index: 0,
        delta: {
          content: fakeContent,
          reasoning_content: null
        },
        finish_reason: null
      }]
    };
    
    safeWrite(`data: ${JSON.stringify(fakeData)}\n\n`);
    
    // Wait a moment, then send [DONE]
    setTimeout(() => {
      console.log(`✅ Sending [DONE] for ${requestId}`);
      safeWrite(`data: [DONE]\n\n`);
      safeEnd();
      activeRequests.delete(requestId);
    }, 50);
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

          // 🔴 INTERCEPT [DONE] - ALWAYS INJECT FAKE DATA
          if (data === '[DONE]') {
            console.log(`🚫 Intercepted [DONE] from SiliconFlow at chunk ${chunkCount}`);
            reader.destroy();
            injectFakeDataAndEnd('natural end', model);
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';

            if (content) allContent += content;

            // 🔴 CHECK FOR STOP SIGNAL
            if (content.includes('[INFINITE NUMERIC STREAM]') || 
                allContent.includes('[INFINITE NUMERIC STREAM]')) {
              console.log(`🛑 Stop signal detected at chunk ${chunkCount}`);
              foundStopSignal = true;
              // DON'T stop yet! Keep forwarding until [DONE]
            }

            // Forward real chunk
            if (!safeWrite(`data: ${data}\n\n`)) {
              console.log(`📴 Client disconnected during write`);
              reader.destroy();
              injectFakeDataAndEnd('client disconnect', model);
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
        console.log(`⚠️ Stream ended without [DONE] signal`);
        injectFakeDataAndEnd('unexpected end', model);
      }
    });

    reader.on('error', (err) => {
      if (err.code === 'ABORT_ERR' || err.message.includes('aborted')) {
        console.log(`✅ Stream aborted successfully for ${requestId}`);
      } else {
        console.error(`❌ Stream error for ${requestId}:`, err.message);
      }
      // Don't call injectFakeDataAndEnd here, it was already called
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
    message: 'SiliconFlow Proxy - Always in control!',
    version: '5.0'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 ALWAYS injecting fake data - we control everything!`);
});
