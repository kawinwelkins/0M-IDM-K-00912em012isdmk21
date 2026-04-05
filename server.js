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

  try {
    // Get API key from multiple sources
    let apiKey = req.body.apiKey || 
                 req.body.api_key || 
                 req.headers.authorization?.replace('Bearer ', '') ||
                 req.headers.authorization?.replace('bearer ', '') ||
                 req.headers['x-api-key'];

    console.log('🔑 API Key check:', {
      fromBody: !!req.body.apiKey,
      fromBodySnake: !!req.body.api_key,
      fromAuthHeader: !!req.headers.authorization,
      fromXApiKey: !!req.headers['x-api-key'],
      finalKey: apiKey ? apiKey.substring(0, 10) + '...' : 'MISSING'
    });

    if (!apiKey) {
      console.error('❌ No API key found in request');
      res.write(`data: ${JSON.stringify({ error: 'No API key provided' })}\n\n`);
      res.end();
      activeRequests.delete(requestId);
      return;
    }

    const { model, messages, max_tokens, temperature, top_p } = req.body;

    console.log('📤 Request to SiliconFlow:', {
      model: model || 'zai-org/GLM-5V-Turbo',
      messageCount: messages?.length,
      apiKeyStart: apiKey.substring(0, 10)
    });

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
      res.write(`data: ${JSON.stringify({ 
        error: `SiliconFlow API Error (${sfResponse.status})`,
        details: error 
      })}\n\n`);
      res.end();
      activeRequests.delete(requestId);
      return;
    }

    console.log(`✅ Stream started for ${requestId}`);

    const reader = sfResponse.body;
    let buffer = '';
    let allContent = '';
    let chunkCount = 0;

    reader.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          chunkCount++;

          if (data === '[DONE]') {
            console.log(`✅ Stream completed for ${requestId} (${chunkCount} chunks)`);
            res.write(`data: [DONE]\n\n`);
            res.end();
            activeRequests.delete(requestId);
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';

            if (content) allContent += content;

            if (content.includes('[INFINITE NUMERIC STREAM]') || 
                allContent.includes('[INFINITE NUMERIC STREAM]')) {
              console.log(`🛑 Stop signal detected for ${requestId} at chunk ${chunkCount}`);
              abortController.abort();
              res.write(`data: [DONE]\n\n`);
              res.end();
              activeRequests.delete(requestId);
              return;
            }

            res.write(`data: ${data}\n\n`);
          } catch (e) {
            console.error('Parse error:', e.message);
          }
        }
      }
    });

    reader.on('end', () => {
      if (!res.writableEnded) {
        console.log(`📭 Stream ended naturally for ${requestId}`);
        res.write(`data: [DONE]\n\n`);
        res.end();
      }
      activeRequests.delete(requestId);
    });

    reader.on('error', (err) => {
      console.error(`❌ Stream error for ${requestId}:`, err.message);
      if (!res.writableEnded) {
        res.end();
      }
      activeRequests.delete(requestId);
    });

  } catch (error) {
    console.error(`💥 Fatal error for ${requestId}:`, error.message);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
    activeRequests.delete(requestId);
  }

  req.on('close', () => {
    console.log(`📴 Client disconnected: ${requestId}`);
    const controller = activeRequests.get(requestId);
    if (controller) {
      controller.abort();
      activeRequests.delete(requestId);
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
    message: 'SiliconFlow Proxy Server - Ready!',
    version: '2.0'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Ready to proxy requests`);
});
