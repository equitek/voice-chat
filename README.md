# Voice Chat

A fully local voice conversation system with no cloud dependencies. Talk naturally with an AI assistant using speech-to-text, text-to-speech, and any OpenAI-compatible language model.

## Features

- **🎤 Hold-to-Talk Interface** - Natural voice input with visual feedback
- **🔊 High-Quality TTS** - Local neural text-to-speech synthesis
- **🧠 Dual Responses** - Get both a spoken summary and detailed text response
- **📝 Multi-Clip Compose** - Record multiple voice clips before sending
- **🌐 Zero Cloud Dependencies** - Everything runs on your local machine
- **⚡ Real-Time** - WebSocket-based communication for instant feedback

## Tech Stack

- **Backend**: Node.js with WebSocket server
- **Frontend**: Vanilla HTML/CSS/JavaScript with Web Audio API
- **Speech-to-Text**: [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) with Whisper models
- **Text-to-Speech**: sherpa-onnx with VITS models
- **LLM Integration**: OpenAI-compatible API (works with any local LLM server)
- **Audio Processing**: FFmpeg for format conversion

## Prerequisites

### Required Software

1. **Node.js** (v16 or later)
   ```bash
   # Ubuntu/Debian
   sudo apt install nodejs npm
   
   # macOS
   brew install node
   ```

2. **FFmpeg** (for audio format conversion)
   ```bash
   # Ubuntu/Debian
   sudo apt install ffmpeg
   
   # macOS  
   brew install ffmpeg
   ```

3. **sherpa-onnx Runtime & Models**
   
   Download and extract the sherpa-onnx runtime:
   ```bash
   # Create tools directory
   mkdir -p ~/.openclaw/tools
   cd ~/.openclaw/tools
   
   # Download sherpa-onnx (adjust URL for your platform)
   wget https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.10.27/sherpa-onnx-v1.10.27-linux-x64.tar.bz2
   tar -xjf sherpa-onnx-v1.10.27-linux-x64.tar.bz2
   mv sherpa-onnx-v1.10.27-linux-x64 sherpa-onnx-tts
   ```
   
   Download TTS model:
   ```bash
   cd sherpa-onnx-tts
   mkdir -p models
   cd models
   
   # Download VITS English model
   wget https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-libritts_r-medium.tar.bz2
   tar -xjf vits-piper-en_US-libritts_r-medium.tar.bz2
   ```
   
   Download STT model:
   ```bash
   # Download Whisper model for speech recognition
   wget https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.en.tar.bz2
   tar -xjf sherpa-onnx-whisper-small.en.tar.bz2
   ```

### LLM Server

You need an OpenAI-compatible API endpoint. Options include:

- **Ollama** (recommended for beginners): https://ollama.ai/
- **OpenAI API**: Direct API access
- **LocalAI**: https://localai.io/
- **vLLM**: https://github.com/vllm-project/vllm
- **Any other OpenAI-compatible server**

Example Ollama setup:
```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull a model
ollama pull qwen2.5:14b

# Start server (runs on localhost:11434)
ollama serve
```

## Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd voice-chat
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment** (see Configuration section below)

4. **Start the server**
   ```bash
   node server.js
   ```

5. **Open in browser**
   ```
   http://localhost:3335
   ```

## Configuration

Configure the system using environment variables. Create a `.env` file or export these variables:

### Core Settings

```bash
# Server port (default: 3335)
PORT=3335

# Sherpa-onnx runtime path
SHERPA_RUNTIME=/home/youruser/.openclaw/tools/sherpa-onnx-tts/runtime

# TTS model path
SHERPA_TTS_MODEL=/home/youruser/.openclaw/tools/sherpa-onnx-tts/models/vits-piper-en_US-libritts_r-medium

# STT model path  
WHISPER_MODEL=/home/youruser/.openclaw/tools/sherpa-onnx-tts/models/sherpa-onnx-whisper-small.en

# TTS speaker ID (0-n, depends on model)
TTS_SPEAKER_ID=0
```

### LLM Integration

For primary LLM (OpenAI-compatible API):
```bash
# If using a gateway/proxy server
OPENCLAW_PORT=18789
OPENCLAW_TOKEN=your-auth-token-here
```

The system will automatically fall back to Ollama at `localhost:11434` if the primary endpoint is unavailable.

### Advanced Settings

```bash
# Bind to specific interface (default: 127.0.0.1)
HOST=0.0.0.0

# Custom paths for models
LD_LIBRARY_PATH=/custom/path/to/sherpa/lib
```

## Usage

### Basic Workflow

1. **Connect**: Open the web interface in your browser
2. **Select Microphone**: Choose your preferred microphone from the dropdown
3. **Hold to Talk**: Press and hold the large circular button while speaking
4. **Multi-Clip Compose**: Release and press again to add more voice clips
5. **Send**: Click the "Send" button when ready to process all clips
6. **Listen**: Hear the AI response and read the detailed text

### Interface Elements

- **🎤 Hold to Talk Button**: Main interaction button
  - **Blue border**: Has recorded clips ready to send
  - **Red border + pulse**: Currently recording
  - **Orange border**: Processing your request  
  - **Green border**: Playing audio response

- **📤 Send Button**: Becomes active when you have recorded clips
- **Status Text**: Shows current system state
- **Clip Counter**: Shows number of recorded clips and total size

### Bottom Controls

- **↩ Undo**: Remove the last recorded clip
- **🗑 Clear**: Remove all recorded clips
- **🔊 Test**: Play a test tone to check audio output

### Response Modes

The system provides dual responses:

1. **Voice Summary**: Concise, spoken response (automatically played)
2. **Detailed Text**: Full response with formatting, code blocks, etc.

Click "Show full response" to expand the detailed text under any AI message.

## Architecture Overview

### Data Flow

```
Browser Microphone → MediaRecorder API → WebSocket
                                            ↓
Audio Chunks → FFmpeg Conversion → sherpa-onnx STT
                                            ↓
Transcript → LLM API → AI Response → sherpa-onnx TTS
                                            ↓
Audio Data → WebSocket → Browser Audio Playback
```

### Components

**Frontend (`public/index.html`)**
- Web Audio API for microphone access
- WebSocket client for real-time communication
- MediaRecorder for audio capture
- HTML5 Audio for playback

**Backend (`server.js`)**
- HTTP server for static file serving
- WebSocket server for audio streaming
- Audio processing pipeline
- LLM integration layer

**Speech Processing**
- **Input**: Browser audio → FFmpeg → 16kHz WAV → sherpa-onnx STT
- **Output**: Text → sherpa-onnx TTS → WAV → Browser playback

**LLM Integration**
- Primary: Custom API endpoint (configurable)
- Fallback: Ollama at localhost:11434
- Dual response generation for voice + detail

## Development

### Running in Development

```bash
# Install dependencies
npm install

# Start with environment variables
SHERPA_RUNTIME=/path/to/runtime node server.js

# Or use nodemon for auto-reload
npm install -g nodemon
nodemon server.js
```

### Adding New Features

The codebase is structured for easy extension:

- **Audio processing**: Modify `convertTo16kWav()` and `transcribe()` functions
- **LLM integration**: Update `getAgentResponse()` for new providers
- **UI enhancements**: Edit `public/index.html`
- **TTS voices**: Adjust `SHERPA_TTS_MODEL` and `TTS_SPEAKER_ID`

### Debugging

Enable debug logging:
```bash
DEBUG=voice-chat node server.js
```

Debug files are saved to `/tmp/voice-chat-debug-last.audio` for audio analysis.

## Troubleshooting

### Common Issues

**"No speech detected"**
- Check microphone permissions in browser
- Try a different microphone from the dropdown
- Record longer clips (hold button for 2+ seconds)

**"Audio conversion failed"**
- Ensure FFmpeg is installed and in PATH
- Check SHERPA_RUNTIME path is correct

**"STT failed" / "TTS failed"**
- Verify sherpa-onnx models are downloaded
- Check LD_LIBRARY_PATH includes sherpa runtime/lib
- Ensure model paths are correct in environment variables

**"Connection error"**
- Check if server is running on correct port
- Verify firewall settings if accessing remotely
- Try refreshing the browser page

**LLM Integration Issues**
- Verify your LLM server is running and accessible
- Check API endpoints and authentication tokens
- Monitor server logs for detailed error messages

### Audio Quality

For best results:
- Use a quality microphone with noise cancellation
- Speak clearly and avoid background noise
- Record in 2+ second clips for reliable transcription
- Test different TTS_SPEAKER_ID values (0-9) for voice variety

## License

MIT License - see LICENSE file for details.

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Test your changes thoroughly
4. Submit a pull request

For bugs and feature requests, please open an issue with:
- System details (OS, Node version, browser)
- Steps to reproduce
- Error messages from browser console and server logs