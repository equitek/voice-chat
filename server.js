#!/usr/bin/env node
/**
 * Voice Chat Server — fully local voice conversation server
 * 
 * Browser → WebSocket (audio) → sherpa-onnx STT → OpenClaw agent → sherpa-onnx TTS → Browser
 * 
 * No cloud dependencies. Runs on Nebula mesh only.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { spawn, execSync } = require('child_process');

const PORT = parseInt(process.env.PORT || '3335');
const SHERPA_RUNTIME = process.env.SHERPA_RUNTIME || `${process.env.HOME}/.openclaw/tools/sherpa-onnx-tts/runtime`;
const SHERPA_TTS_MODEL = process.env.SHERPA_TTS_MODEL || `${process.env.HOME}/.openclaw/tools/sherpa-onnx-tts/models/vits-piper-en_US-libritts_r-medium`;
const WHISPER_MODEL = process.env.WHISPER_MODEL || `${process.env.HOME}/.openclaw/tools/sherpa-onnx-tts/models/sherpa-onnx-whisper-small.en`;
const TTS_SPEAKER_ID = parseInt(process.env.TTS_SPEAKER_ID || '0');

// OpenClaw gateway for agent interaction
const OPENCLAW_PORT = parseInt(process.env.OPENCLAW_PORT || '18789');
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '';

const LD_LIBRARY_PATH = `${SHERPA_RUNTIME}/lib:${process.env.LD_LIBRARY_PATH || ''}`;

// Serve static files
const STATIC_DIR = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  // Strip /voice prefix if present (Caddy proxies /voice* to us)
  let urlPath = req.url.replace(/\?.*$/, '');
  urlPath = urlPath.replace(/^\/voice\/?/, '/');
  if (urlPath === '' || urlPath === '/') urlPath = '/index.html';

  let filePath = path.join(STATIC_DIR, urlPath);
  console.log(`[voice-chat] HTTP ${req.method} ${req.url} -> ${urlPath}`);

  const ext = path.extname(filePath);
  const contentTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

console.log(`[voice-chat] sherpa-onnx runtime: ${SHERPA_RUNTIME}`);
console.log(`[voice-chat] TTS model: ${SHERPA_TTS_MODEL}`);
console.log(`[voice-chat] Whisper model: ${WHISPER_MODEL}`);

/**
 * Remove repeated phrases from Whisper output (hallucination artifact)
 */
function deduplicateTranscript(text) {
  if (!text) return text;
  const words = text.split(/\s+/);
  if (words.length < 4) return text;
  
  // Strategy: find the longest non-repeating prefix
  // For each possible split point, check if everything after it is a 
  // prefix/substring of everything before it
  let best = text;
  
  // Check from the middle outward — find where repetition starts
  for (let split = Math.ceil(words.length / 2); split < words.length - 1; split++) {
    const firstHalf = words.slice(0, split).join(' ');
    const secondHalf = words.slice(split).join(' ');
    // If secondHalf (2+ words) is a prefix of firstHalf, it's a repeat
    if (secondHalf.split(/\s+/).length >= 2 && 
        firstHalf.toLowerCase().startsWith(secondHalf.toLowerCase())) {
      best = firstHalf;
      break;
    }
    // If secondHalf appears anywhere in firstHalf starting at a word boundary
    const fLower = firstHalf.toLowerCase();
    const sLower = secondHalf.toLowerCase();
    if (sLower.split(/\s+/).length >= 2) {
      // Check if secondHalf matches the start of any sentence in firstHalf
      const sentences = firstHalf.split(/[.!?]+\s*/);
      for (const sent of sentences) {
        if (sent.toLowerCase().startsWith(sLower)) {
          best = firstHalf;
          break;
        }
      }
      if (best !== text) break;
    }
  }
  
  // Also handle exact full-segment repeats: "A B C A B C" → "A B C"
  for (let len = 2; len <= Math.floor(words.length / 2); len++) {
    const seg = words.slice(0, len).join(' ').toLowerCase();
    const next = words.slice(len, len * 2).join(' ').toLowerCase();
    if (seg === next) {
      // Remove the repeat and recurse
      const cleaned = words.slice(0, len).join(' ') + ' ' + words.slice(len * 2).join(' ');
      return deduplicateTranscript(cleaned.trim());
    }
  }
  
  return best;
}

/**
 * Convert audio to 16kHz mono WAV (required by sherpa-onnx)
 */
function convertTo16kWav(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath + '.16k.wav';
    const proc = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
      outputPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`ffmpeg failed: ${stderr.slice(-200)}`));
        return;
      }
      resolve(outputPath);
    });
  });
}

/**
 * Run sherpa-onnx STT on a WAV file
 */
function transcribe(wavPath) {
  return new Promise(async (resolve, reject) => {
    // Convert to 16kHz mono first (browser may send different sample rate)
    let convertedPath;
    try {
      convertedPath = await convertTo16kWav(wavPath);
    } catch (err) {
      reject(new Error(`Audio conversion failed: ${err.message}`));
      return;
    }

    const args = [
      `--whisper-encoder=${WHISPER_MODEL}/small.en-encoder.onnx`,
      `--whisper-decoder=${WHISPER_MODEL}/small.en-decoder.onnx`,
      `--tokens=${WHISPER_MODEL}/small.en-tokens.txt`,
      `--model-type=whisper`,
      `--whisper-tail-paddings=10`,
      convertedPath,
    ];

    const proc = spawn(`${SHERPA_RUNTIME}/bin/sherpa-onnx-offline`, args, {
      env: { ...process.env, LD_LIBRARY_PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    // sherpa-onnx writes EVERYTHING to stderr (including transcripts)
    proc.stdout.on('data', d => output += d);
    proc.stderr.on('data', d => output += d);

    proc.on('close', code => {
      // Clean up converted file
      try { fs.unlinkSync(convertedPath); } catch {}

      if (code !== 0 && code !== null) {
        reject(new Error(`STT failed (code ${code}): ${output.slice(-500)}`));
        return;
      }

      // Parse transcript — look for JSON line with "text" field in combined output
      const lines = output.trim().split('\n');
      let transcript = '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.includes('"text"')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.text) {
              transcript = parsed.text.trim();
              break;
            }
          } catch {}
        }
      }
      // Dedup repeated phrases (Whisper hallucination)
      const deduped = deduplicateTranscript(transcript);
      console.log(`[voice-chat] STT parsed: "${transcript}"`);
      if (deduped !== transcript) console.log(`[voice-chat] STT deduped: "${deduped}"`);
      resolve(deduped);
    });
  });
}

/**
 * Run sherpa-onnx TTS, return WAV buffer (universally decodable by browsers)
 */
function synthesize(text) {
  return new Promise((resolve, reject) => {
    const wavPath = `/tmp/voice-chat-tts-${Date.now()}.wav`;
    const args = [
      `--vits-model=${SHERPA_TTS_MODEL}/en_US-libritts_r-medium.onnx`,
      `--vits-tokens=${SHERPA_TTS_MODEL}/tokens.txt`,
      `--vits-data-dir=${SHERPA_TTS_MODEL}/espeak-ng-data`,
      `--sid=${TTS_SPEAKER_ID}`,
      `--output-filename=${wavPath}`,
      text,
    ];

    const proc = spawn(`${SHERPA_RUNTIME}/bin/sherpa-onnx-offline-tts`, args, {
      env: { ...process.env, LD_LIBRARY_PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', d => stderr += d);

    proc.on('close', code => {
      if (code !== 0) {
        try { fs.unlinkSync(wavPath); } catch {}
        reject(new Error(`TTS failed (code ${code}): ${stderr}`));
        return;
      }

      try {
        const wavData = fs.readFileSync(wavPath);
        fs.unlinkSync(wavPath);
        resolve(wavData);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Get a dual response: full detailed response + concise voice summary
 * Returns { voice: string, detail: string }
 */
async function getAgentResponse(userMessage, conversationHistory) {
  const GATEWAY_PORT = process.env.OPENCLAW_PORT || 18789;
  const GATEWAY_TOKEN = process.env.OPENCLAW_TOKEN || '';

  // Read gateway token from config if not in env
  let token = GATEWAY_TOKEN;
  if (!token) {
    try {
      const config = JSON.parse(fs.readFileSync(
        path.join(process.env.HOME, '.openclaw/openclaw.json'), 'utf8'
      ));
      token = config.gateway?.auth?.token || '';
    } catch (e) {
      console.error('[voice-chat] Failed to read gateway config:', e.message);
    }
  }

  const messages = [
    { role: 'system', content: "You are a helpful AI assistant. Provide complete, detailed responses with full context. Use markdown formatting, lists, and code blocks as appropriate." },
    ...conversationHistory.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.role === 'assistant' ? m.detail || m.text : m.text,
    })),
  ];
  if (!messages.length || messages[messages.length - 1].content !== userMessage) {
    messages.push({ role: 'user', content: userMessage });
  }

  let detailText = '';

  // Try OpenClaw gateway first (full agent)
  if (token) {
    try {
      detailText = await callAPI('127.0.0.1', GATEWAY_PORT, '/v1/chat/completions', {
        model: 'openclaw:main',
        messages,
        max_tokens: 1000,
      }, { 'Authorization': `Bearer ${token}` }, 25000);
    } catch (e) {
      console.error('[voice-chat] Gateway failed, falling back to Ollama:', e.message);
    }
  }

  // Fallback: local Ollama for main response
  if (!detailText) {
    try {
      // For fallback, use voice-friendly system prompt
      const voiceMessages = [
        { role: 'system', content: "You are on a voice call. Keep responses concise and conversational (1-3 sentences). No markdown, no lists, no code blocks, no formatting. Speak naturally like a real person. Don't use emoji." },
        ...conversationHistory.map(m => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.text,
        })),
      ];
      if (!voiceMessages.length || voiceMessages[voiceMessages.length - 1].content !== userMessage) {
        voiceMessages.push({ role: 'user', content: userMessage });
      }

      detailText = await callAPI('127.0.0.1', 11434, '/v1/chat/completions', {
        model: 'qwen2.5:14b',
        messages: voiceMessages,
        max_tokens: 300,
        temperature: 0.7,
      }, {}, 20000);
    } catch (e) {
      console.error('[voice-chat] Ollama also failed:', e.message);
      detailText = "Both my brain and my backup brain are down. Try again in a moment?";
    }
  }

  // If we got a detailed response from gateway, summarize it for voice
  let voiceText = detailText;
  if (token && detailText && detailText.length > 100) {
    try {
      voiceText = await callAPI('127.0.0.1', 11434, '/v1/chat/completions', {
        model: 'qwen2.5:14b',
        messages: [
          { 
            role: 'system', 
            content: "Summarize the following AI assistant response into 1-2 natural spoken sentences. No markdown, no lists, no formatting. Speak like a real person giving a quick verbal answer." 
          },
          { role: 'user', content: detailText }
        ],
        max_tokens: 100,
        temperature: 0.3,
      }, {}, 10000);
    } catch (e) {
      console.error('[voice-chat] Ollama summarization failed:', e.message);
      // Fallback: use first sentence or truncate
      voiceText = detailText.split(/[.!?]\s+/)[0] + (detailText.includes('.') ? '.' : '');
      if (voiceText.length > 200) {
        voiceText = detailText.substring(0, 150) + '...';
      }
    }
  }

  return { voice: voiceText, detail: detailText };
}

/**
 * Generic OpenAI-compatible chat completions call
 */
function callAPI(host, port, path_url, body, extraHeaders, timeoutMs) {
  return new Promise((resolve, reject) => {
    const http2 = require('http');
    const req = http2.request({
      hostname: host,
      port,
      path: path_url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.choices?.[0]?.message?.content;
          if (text) {
            resolve(text);
          } else if (parsed.error) {
            reject(new Error(JSON.stringify(parsed.error)));
          } else {
            reject(new Error('Unexpected response: ' + data.slice(0, 200)));
          }
        } catch (e) {
          reject(new Error('JSON parse error: ' + e.message));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

wss.on('connection', (ws) => {
  console.log('[voice-chat] Client connected');
  const conversationHistory = [];

  ws.on('message', async (data, isBinary) => {
    if (!isBinary) {
      // Text message — could be control commands
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
        return;
      } catch {}
      return;
    }

    // Binary message — audio data (WAV from browser)
    console.log(`[voice-chat] Received audio: ${data.length} bytes`);

    // Skip tiny recordings (just WAV header, no actual audio)
    if (data.length < 1000) {
      console.log('[voice-chat] Audio too short, skipping');
      ws.send(JSON.stringify({ type: 'status', text: 'Recording too short — hold longer' }));
      return;
    }

    // Save as generic audio file (could be webm, mp4, or wav from browser)
    const ts = Date.now();
    const tmpAudio = `/tmp/voice-chat-input-${ts}.audio`;
    fs.writeFileSync(tmpAudio, data);
    // Keep a debug copy of the last recording
    fs.writeFileSync('/tmp/voice-chat-debug-last.audio', data);
    console.log(`[voice-chat] Saved debug copy: ${data.length} bytes`);

    try {
      // Step 1: STT
      ws.send(JSON.stringify({ type: 'status', text: 'Transcribing...' }));
      const startSTT = Date.now();
      const transcript = await transcribe(tmpAudio);
      const sttMs = Date.now() - startSTT;
      console.log(`[voice-chat] STT (${sttMs}ms): "${transcript}"`);

      if (!transcript || transcript.trim().length === 0) {
        ws.send(JSON.stringify({ type: 'status', text: 'No speech detected' }));
        return;
      }

      ws.send(JSON.stringify({ type: 'transcript', text: transcript, latencyMs: sttMs }));
      conversationHistory.push({ role: 'user', text: transcript });

      // Step 2: Get agent response
      ws.send(JSON.stringify({ type: 'status', text: 'Thinking...' }));
      const startAgent = Date.now();
      const response = await getAgentResponse(transcript, conversationHistory);
      const agentMs = Date.now() - startAgent;
      
      // Handle both old string format and new dual format
      const voiceText = typeof response === 'string' ? response : response.voice;
      const detailText = typeof response === 'string' ? response : response.detail;
      
      console.log(`[voice-chat] Agent (${agentMs}ms): voice="${voiceText.substring(0, 50)}..." detail="${detailText.substring(0, 50)}..."`);

      ws.send(JSON.stringify({ 
        type: 'response', 
        voice: voiceText,
        detail: detailText,
        latencyMs: agentMs 
      }));
      conversationHistory.push({ role: 'assistant', text: voiceText, detail: detailText });

      // Step 3: TTS (use voice text, not detail)
      ws.send(JSON.stringify({ type: 'status', text: 'Speaking...' }));
      const startTTS = Date.now();
      const audioData = await synthesize(voiceText);
      const ttsMs = Date.now() - startTTS;
      console.log(`[voice-chat] TTS (${ttsMs}ms): ${audioData.length} bytes`);

      // Send audio as binary
      ws.send(audioData);

    } catch (err) {
      console.error('[voice-chat] Error:', err);
      ws.send(JSON.stringify({ type: 'error', text: err.message }));
    } finally {
      try { fs.unlinkSync(tmpAudio); } catch {}
    }
  });

  ws.on('close', () => {
    console.log('[voice-chat] Client disconnected');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[voice-chat] Server listening on http://127.0.0.1:${PORT}`);
  console.log(`[voice-chat] Ready for connections`);
});
