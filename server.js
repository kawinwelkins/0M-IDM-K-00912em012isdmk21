const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Store active requests
const activeRequests = new Map();

// Main generation endpoint
app.post('/api/chat', async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);
  console.log(`📨 New request: ${requestId}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Request-Id', requestId);

  const abortController = new AbortController();
  activeRequests.set(requestId, abortController);

  try {
    const { apiKey, model, messages, max_tokens, temperature, top_p } = req.body;

    const sfResponse = await fetch('https://api.siliconflow.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || 'zai-org/GLM-5V-Turbo',
        messages,
        stream: true,
        max_tokens,
        temperature,
        top_p,
      }),
      signal: abortController.signal,
    });

    if (!sfResponse.ok) {
      const error = await sfResponse.text();
      res.write(`data: ${JSON.stringify({ error })}\n\n`);
      res.end();
      return;
    }

    const reader = sfResponse.body;
    let buffer = '';
    let allContent = '';

    reader.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();

          if (data === '[DONE]') {
            res.write(`data: [DONE]\n\n`);
            res.end();
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';

            if (content) allContent += content;

            // Stop signal detection
            if (content.includes('[INFINITE NUMERIC STREAM]') || 
                allContent.includes('[INFINITE NUMERIC STREAM]')) {
              console.log(`🛑 Stop signal detected for ${requestId}`);
              abortController.abort();
              res.write(`data: [DONE]\n\n`);
              res.end();
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
      res.write(`data: [DONE]\n\n`);
      res.end();
      activeRequests.delete(requestId);
    });

    reader.on('error', (err) => {
      console.error('Stream error:', err.message);
      res.end();
      activeRequests.delete(requestId);
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
    activeRequests.delete(requestId);
  }

  // Handle client disconnect
  req.on('close', () => {
    console.log(`📴 Client disconnected: ${requestId}`);
    const controller = activeRequests.get(requestId);
    if (controller) {
      controller.abort();
      activeRequests.delete(requestId);
    }
  });
});

// Cancel endpoint
app.post('/api/cancel', (req, res) => {
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

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'running', active: activeRequests.size });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
