// Backend server for Twilio token generation
// This runs on Node.js and securely generates video call tokens
// Run with: node server.js

import express from 'express';
import cors from 'cors';
import twilio from 'twilio';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';

// Load environment variables
dotenv.config(); // loads .env by default
// Also load .env.local if present (won't override existing exports)
try {
  const localEnvPath = path.join(process.cwd(), '.env.local');
  if (fs.existsSync(localEnvPath)) {
    dotenv.config({ path: localEnvPath, override: false });
  }
} catch {}

const app = express();

// Enhanced CORS configuration — accept any localhost port for dev
const corsOriginCheck = (origin, callback) => {
  // Allow requests with no origin (mobile apps, curl, etc.)
  if (!origin) return callback(null, true);
  // Allow any localhost / 127.0.0.1 origin
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return callback(null, true);
  }
  callback(new Error('Not allowed by CORS'));
};

app.use(cors({

  origin: [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:5176',
    'http://localhost:4000',
    'http://localhost:4002',
    'http://localhost:4003',
    'http://localhost:4004',
    'http://localhost:4005',
  ],

  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Multer setup for image uploads (stored in tmp)
const upload = multer({ dest: path.join(process.cwd(), 'tmp_uploads') });
// Multer for batch uploads (arrays)
const uploadMany = multer({ dest: path.join(process.cwd(), 'tmp_uploads') });

// Twilio credentials - keep these server-side only!
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'AC2cc154bd458d2b30823ed81f6a64133f';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'f69a611c61ee033cbec7e2ee5c477bfd';
const TWILIO_API_KEY = process.env.TWILIO_API_KEY || '';

const twilio_client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Hugging Face config
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY || '';
const HF_TOKEN = process.env.HF_TOKEN || HUGGINGFACE_API_KEY;
const EMOTION_PROVIDER = process.env.EMOTION_PROVIDER || (HUGGINGFACE_API_KEY ? 'hf' : 'local');
const HF_TEXT_MODEL = process.env.HF_TEXT_MODEL || 'SamLowe/roberta-base-go_emotions';
const HF_IMAGE_MODEL = process.env.HF_IMAGE_MODEL || 'trpakov/vit-face-expression';
const HF_AUDIO_MODEL = process.env.HF_AUDIO_MODEL || 'ehcalabres/wav2vec2-lg-xlsr-en-speech-emotion-recognition';

// Track active call rooms in memory (for demo; use database in production)
const activeRooms = new Map();

/**
 * POST /api/twilio/create-room
 * Create or get a video call room
 */
app.post('/api/twilio/create-room', async (req, res) => {
  try {
    const { callSessionId, doctorId, patientId } = req.body;

    if (!callSessionId) {
      return res.status(400).json({ message: 'callSessionId is required' });
    }

    const roomName = `call-${callSessionId}`;
    
    // Check if room already exists
    if (activeRooms.has(roomName)) {
      return res.json({ 
        success: true, 
        roomName, 
        message: 'Existing room retrieved' 
      });
    }

    // Create a new room in Twilio
    try {
      const room = await twilio_client.video.rooms.create({
        uniqueName: roomName,
        type: 'peer-to-peer', // Use peer-to-peer for 1-on-1 calls, or 'group' for multiple participants
        recordParticipantsOnConnect: false,
        statusCallback: 'https://example.com/twilio-callback', // Add your callback URL here
      });

      activeRooms.set(roomName, {
        sid: room.sid,
        name: roomName,
        createdAt: new Date(),
        participants: []
      });

      console.log(`✅ Room created: ${roomName} (SID: ${room.sid})`);

      res.json({ 
        success: true, 
        roomName,
        roomSid: room.sid,
        message: 'Room created successfully' 
      });
    } catch (err) {
      // Room might already exist, that's fine
      if (err.code === 54301) {
        activeRooms.set(roomName, {
          name: roomName,
          createdAt: new Date(),
          participants: []
        });
        return res.json({ 
          success: true, 
          roomName,
          message: 'Existing room retrieved' 
        });
      }
      throw err;
    }
  } catch (error) {
    console.error('Error creating room:', error);
    res.status(500).json({ message: 'Failed to create room', error: error.message });
  }
});

/**
 * POST /api/twilio/token
 * Generate an access token for Twilio Video
 */
app.post('/api/twilio/token', async (req, res) => {
  try {
    const { identity, roomName } = req.body;

    if (!identity || !roomName) {
      return res.status(400).json({ message: 'identity and roomName are required' });
    }

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      return res.status(500).json({ message: 'Twilio credentials not configured' });
    }

    // Create access token
    const AccessToken = twilio.jwt.AccessToken;
    const VideoGrant = AccessToken.VideoGrant;

    const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY || TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, { identity });
    token.addGrant(new VideoGrant({ room: roomName }));

    // Track participant in room
    if (activeRooms.has(roomName)) {
      const room = activeRooms.get(roomName);
      if (!room.participants.includes(identity)) {
        room.participants.push(identity);
      }
    }

    console.log(`✅ Token generated for ${identity} in room ${roomName}`);

    res.json({ token: token.toJwt(), roomName });
  } catch (error) {
    console.error('Error generating token:', error);
    res.status(500).json({ message: 'Failed to generate token', error: error.message });
  }
});

/**
 * POST /api/cv/emotion
 * Accepts an image file and returns detected emotions using the Python CV model.
 * Content-Type: multipart/form-data with field name 'image'
 */
app.post('/api/cv/emotion', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image uploaded' });
    }

    const imagePath = req.file.path;
    const mimetype = req.file.mimetype || 'image/jpeg';

    // Provider: Hugging Face (default when API key present)
    if (EMOTION_PROVIDER !== 'local') {
      if (!HF_TOKEN) {
        fs.unlink(imagePath, () => {});
        return res.status(500).json({ success: false, error: 'Missing HF_TOKEN or HUGGINGFACE_API_KEY' });
      }
      try {
        const buffer = fs.readFileSync(imagePath);
        // Use configurable HF image model (default: trpakov/vit-face-expression)
        const resp = await fetch(`https://router.huggingface.co/hf-inference/models/${encodeURIComponent(HF_IMAGE_MODEL)}` , {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${HF_TOKEN}`,
            'Content-Type': mimetype,
            'Accept': 'application/json'
          },
          body: buffer,
        });

        const ct = resp.headers.get('content-type') || '';
        let data;
        try {
          if (ct.includes('application/json')) {
            data = await resp.json();
          } else {
            const text = await resp.text();
            // Attempt to parse if it looks like JSON; else wrap as error
            try {
              data = JSON.parse(text);
            } catch {
              data = { error: 'Non-JSON response from Hugging Face', raw: text };
            }
          }
        } catch (parseErr) {
          data = { error: 'Failed to parse Hugging Face response', raw: await resp.text() };
        }

        fs.unlink(imagePath, () => {});

        if (!resp.ok) {
          return res.status(resp.status).json({ success: false, error: data?.error || 'Hugging Face inference failed', raw: data?.raw });
        }

        // HF image-classification returns array of {label, score}
        const top = Array.isArray(data) && data.length ? data[0] : null;
        const label = top?.label || 'Unknown';
        return res.json({ success: true, faces: [{ bbox: null, emotion: label, score: top?.score }] });
      } catch (e) {
        fs.unlink(imagePath, () => {});
        return res.status(500).json({ success: false, error: e.message });
      }
    }

    // Provider: Local Python fallback
    const pythonScript = path.join(process.cwd(), 'cv', 'o.py');
    const pythonExec = process.env.CV_PYTHON || path.join(process.cwd(), 'cv', '.venv_py311', 'bin', 'python');

    const py = spawn(pythonExec, [pythonScript, '--image', imagePath], { env: process.env });

    let stdout = '';
    let stderr = '';
    let responded = false;
    py.on('error', (err) => {
      fs.unlink(imagePath, () => {});
      if (!responded) {
        responded = true;
        return res.status(500).json({ success: false, error: `Python process error: ${err.message}. Set CV_PYTHON env var or install Python venv.` });
      }
    });
    py.stdout.on('data', (d) => { stdout += d.toString(); });
    py.stderr.on('data', (d) => { stderr += d.toString(); });
    py.on('close', (code) => {
      fs.unlink(imagePath, () => {});
      if (responded) return;
      responded = true;
      if (code !== 0) {
        return res.status(500).json({ success: false, error: stderr || 'Python process failed' });
      }
      try {
        const parsed = JSON.parse(stdout);
        return res.json(parsed);
      } catch (e) {
        return res.status(500).json({ success: false, error: 'Invalid JSON from CV model', raw: stdout });
      }
    });
  } catch (error) {
    console.error('Error in /api/cv/emotion:', error);
    res.status(500).json({ success: false, message: 'Emotion analysis failed', error: error.message });
  }
});

/**
 * POST /api/cv/emotion/batch
 * Accepts 2-3 images and returns aggregated emotion with per-image results.
 * Content-Type: multipart/form-data with field name 'images'
 */
app.post('/api/cv/emotion/batch', uploadMany.array('images', 5), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ success: false, message: 'No images uploaded' });
    }

    const analyzeOneHF = async (file) => {
      const mimetype = file.mimetype || 'image/jpeg';
      const buffer = fs.readFileSync(file.path);
      const resp = await fetch(`https://router.huggingface.co/hf-inference/models/${encodeURIComponent(HF_IMAGE_MODEL)}` , {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HF_TOKEN}`,
          'Content-Type': mimetype,
          'Accept': 'application/json'
        },
        body: buffer,
      });
      const ct = resp.headers.get('content-type') || '';
      let data;
      if (ct.includes('application/json')) {
        data = await resp.json();
      } else {
        const text = await resp.text();
        try { data = JSON.parse(text); } catch { data = { error: 'Non-JSON', raw: text }; }
      }
      return { ok: resp.ok, status: resp.status, data };
    };

    const results = [];
    if (EMOTION_PROVIDER !== 'local') {
      if (!HF_TOKEN) {
        files.forEach(f => fs.unlink(f.path, () => {}));
        return res.status(500).json({ success: false, error: 'Missing HF_TOKEN' });
      }
      for (const f of files) {
        try {
          const r = await analyzeOneHF(f);
          fs.unlink(f.path, () => {});
          if (!r.ok) {
            results.push({ error: r.data?.error || 'HF failed', status: r.status });
          } else {
            const arr = Array.isArray(r.data) ? r.data : [];
            const top = arr.length ? arr[0] : null;
            results.push({ emotion: top?.label || 'Unknown', score: top?.score || 0 });
          }
        } catch (e) {
          fs.unlink(f.path, () => {});
          results.push({ error: e.message });
        }
      }
    } else {
      // Local Python fallback for batch: sequentially process
      for (const f of files) {
        const pythonScript = path.join(process.cwd(), 'cv', 'o.py');
        const pythonExec = process.env.CV_PYTHON || path.join(process.cwd(), 'cv', '.venv_py311', 'bin', 'python');
        const py = spawn(pythonExec, [pythonScript, '--image', f.path], { env: process.env });
        let stdout = ''; let stderr = '';
        await new Promise((resolve) => {
          py.on('error', (err) => { stderr = err.message; resolve(); });
          py.stdout.on('data', d => { stdout += d.toString(); });
          py.stderr.on('data', d => { stderr += d.toString(); });
          py.on('close', () => resolve());
        });
        fs.unlink(f.path, () => {});
        if (stderr) {
          results.push({ error: stderr });
        } else {
          try {
            const parsed = JSON.parse(stdout);
            const first = parsed?.faces?.[0];
            results.push({ emotion: first?.emotion || 'Unknown', score: first?.score || 0 });
          } catch (e) {
            results.push({ error: 'Invalid JSON', raw: stdout });
          }
        }
      }
    }

    // Aggregate: pick the emotion with highest average score
    const scoresByLabel = {};
    results.forEach(r => {
      if (r.emotion && typeof r.score === 'number') {
        const key = r.emotion;
        scoresByLabel[key] = scoresByLabel[key] || { sum: 0, count: 0 };
        scoresByLabel[key].sum += r.score;
        scoresByLabel[key].count += 1;
      }
    });
    let aggregated = null;
    Object.entries(scoresByLabel).forEach(([label, { sum, count }]) => {
      const avg = sum / count;
      if (!aggregated || avg > aggregated.score) aggregated = { emotion: label, score: avg };
    });

    return res.json({ success: true, aggregated, results });
  } catch (error) {
    (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
    console.error('Error in /api/cv/emotion/batch:', error);
    res.status(500).json({ success: false, message: 'Batch emotion analysis failed', error: error.message });
  }
});

/**
 * GET /api/twilio/rooms
 * List active video rooms
 */
app.get('/api/twilio/rooms', async (req, res) => {
  try {
    const rooms = await twilio_client.video.rooms.list({ status: 'in-progress', limit: 100 });
    res.json({ 
      rooms: rooms.map(r => ({ 
        sid: r.sid, 
        name: r.uniqueName,
        participantCount: r.participantCount,
        duration: r.duration
      })) 
    });
  } catch (error) {
    console.error('Error listing rooms:', error);
    res.status(500).json({ message: 'Failed to list rooms', error: error.message });
  }
});

/**
 * GET /api/twilio/rooms/:roomName/info
 * Get room info
 */
app.get('/api/twilio/rooms/:roomName/info', (req, res) => {
  try {
    const { roomName } = req.params;
    
    if (activeRooms.has(roomName)) {
      const room = activeRooms.get(roomName);
      return res.json({ 
        success: true,
        room: {
          name: room.name,
          participants: room.participants,
          createdAt: room.createdAt
        }
      });
    }

    res.status(404).json({ message: 'Room not found' });
  } catch (error) {
    console.error('Error getting room info:', error);
    res.status(500).json({ message: 'Failed to get room info', error: error.message });
  }
});

/**
 * DELETE /api/twilio/rooms/:roomName
 * Close a video room
 */
app.delete('/api/twilio/rooms/:roomName', async (req, res) => {
  try {
    const { roomName } = req.params;

    // Find room by unique name and close it
    const rooms = await twilio_client.video.rooms.list({ status: 'in-progress', limit: 100 });
    const room = rooms.find(r => r.uniqueName === roomName);

    if (room) {
      await twilio_client.video.rooms(room.sid).update({ status: 'completed' });
      console.log(`✅ Room closed: ${roomName}`);
    }

    activeRooms.delete(roomName);
    res.json({ success: true, message: 'Room closed' });
  } catch (error) {
    console.error('Error closing room:', error);
    res.status(500).json({ message: 'Failed to close room', error: error.message });
  }
});

const PORT = process.env.PORT || 4000;

// Create HTTP server and attach Socket.IO for WebRTC signaling
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {

    origin: [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:5175',
      'http://localhost:5176',
      'http://localhost:4000',
      'http://localhost:4002',
      'http://localhost:4003',
      'http://localhost:4004',
      'http://localhost:4005',
    ],

    credentials: true,
    methods: ['GET', 'POST']
  }
});

// ============== WebRTC Signaling Server ==============
const connectedUsers = new Map(); // socketId -> { userId, userName }
const userSocketMap = new Map(); // userId -> socketId (reverse lookup for call routing)
const videoRooms = new Map(); // roomId -> { participants: [], createdAt }

io.on('connection', (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);

  // Register user
  socket.on('user:register', (data, callback) => {
    const { userId, userName, userImage } = data;
    connectedUsers.set(socket.id, { userId, userName, userImage, socketId: socket.id });
    userSocketMap.set(userId, socket.id); // reverse lookup
    console.log(`✅ User registered: ${userName} (${userId}) -> socket ${socket.id}`);
    
    if (callback) callback({ success: true, socketId: socket.id });
    socket.emit('user:registered', { success: true, socketId: socket.id });
  });

  // ============== Call Notification Events ==============

  // Initiate a call to a specific user
  socket.on('call:initiate', (data, callback) => {
    const { targetUserId, callerName, callerImage, roomId } = data;
    const caller = connectedUsers.get(socket.id);
    const targetSocketId = userSocketMap.get(targetUserId);

    console.log(`📞 Call initiated: ${caller?.userName} -> ${targetUserId} (room: ${roomId})`);

    if (!targetSocketId) {
      console.log(`❌ Target user ${targetUserId} not online`);
      if (callback) callback({ success: false, reason: 'user_offline' });
      socket.emit('call:failed', { reason: 'user_offline', message: 'User is not online' });
      return;
    }

    // Send incoming call notification to target user
    io.to(targetSocketId).emit('call:incoming', {
      callerId: caller?.userId,
      callerName: callerName || caller?.userName || 'Unknown',
      callerImage: callerImage || caller?.userImage || '',
      callerSocketId: socket.id,
      roomId,
      timestamp: Date.now(),
    });

    console.log(`📲 Incoming call sent to socket ${targetSocketId}`);
    if (callback) callback({ success: true, message: 'Call notification sent' });
  });

  // Accept an incoming call
  socket.on('call:accept', (data) => {
    const { callerId, callerSocketId, roomId } = data;
    const accepter = connectedUsers.get(socket.id);

    // Notify the caller that the call was accepted
    const targetSocketId = callerSocketId || userSocketMap.get(callerId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call:accepted', {
        acceptedBy: accepter?.userId,
        acceptedByName: accepter?.userName,
        acceptedBySocketId: socket.id,
        roomId,
      });
      console.log(`✅ Call accepted: ${accepter?.userName} accepted call from ${callerId}`);
    }
  });

  // Reject an incoming call
  socket.on('call:reject', (data) => {
    const { callerId, callerSocketId, roomId } = data;
    const rejecter = connectedUsers.get(socket.id);

    const targetSocketId = callerSocketId || userSocketMap.get(callerId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call:rejected', {
        rejectedBy: rejecter?.userId,
        rejectedByName: rejecter?.userName,
        roomId,
      });
      console.log(`❌ Call rejected: ${rejecter?.userName} rejected call from ${callerId}`);
    }
  });

  // Cancel an outgoing call (caller hangs up before answer)
  socket.on('call:cancel', (data) => {
    const { targetUserId, roomId } = data;
    const canceller = connectedUsers.get(socket.id);

    const targetSocketId = userSocketMap.get(targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call:cancelled', {
        cancelledBy: canceller?.userId,
        cancelledByName: canceller?.userName,
        roomId,
      });
      console.log(`🚫 Call cancelled: ${canceller?.userName} cancelled call to ${targetUserId}`);
    }
  });

  // End an active call — notify everyone else in the room
  socket.on('call:end', (data) => {
    const { roomId } = data;
    const ender = connectedUsers.get(socket.id);

    console.log(`📴 Call ended by: ${ender?.userName} in room ${roomId}`);

    // Broadcast to all other sockets in the room
    if (roomId) {
      socket.to(roomId).emit('call:ended', {
        endedBy: ender?.userId,
        endedByName: ender?.userName,
        roomId,
      });
    }
  });

  // Create room
  socket.on('room:create', (data, callback) => {
    const { roomName } = data;
    const roomId = roomName || `room-${Date.now()}`;
    const user = connectedUsers.get(socket.id);
    
    videoRooms.set(roomId, {
      participants: [{ ...user, socketId: socket.id }],
      createdAt: new Date(),
      hostSocketId: socket.id
    });
    
    socket.join(roomId);
    console.log(`🏠 Room created: ${roomId} by ${user?.userName}`);
    
    if (callback) callback({ success: true, roomId, roomName: roomId });
    // Also emit event for clients waiting on it
    socket.emit('room:created', { success: true, roomId, roomName: roomId });
  });

  // Join room
  socket.on('room:join', (data, callback) => {
    const { roomId } = data;
    const user = connectedUsers.get(socket.id);
    
    if (!videoRooms.has(roomId)) {
      // Create room if it doesn't exist
      videoRooms.set(roomId, {
        participants: [],
        createdAt: new Date()
      });
    }
    
    const room = videoRooms.get(roomId);
    room.participants.push({ ...user, socketId: socket.id });
    socket.join(roomId);
    
    // Notify others in room
    socket.to(roomId).emit('room:participantJoined', {
      participant: { ...user, socketId: socket.id },
      allParticipants: room.participants
    });
    
    console.log(`👤 ${user?.userName} joined room: ${roomId}`);
    
    const response = { 
      success: true, 
      roomId, 
      participants: room.participants
    };
    
    if (callback) callback(response);
    // Also emit event for clients waiting on it
    socket.emit('room:joined', response);
  });

  // Leave room
  socket.on('room:leave', (data) => {
    const { roomId } = data;
    const user = connectedUsers.get(socket.id);
    
    if (videoRooms.has(roomId)) {
      const room = videoRooms.get(roomId);
      room.participants = room.participants.filter(p => p.socketId !== socket.id);
      
      // Notify others
      socket.to(roomId).emit('room:participantLeft', {
        participant: { ...user, socketId: socket.id },
        allParticipants: room.participants
      });
      
      // Clean up empty rooms
      if (room.participants.length === 0) {
        videoRooms.delete(roomId);
        console.log(`🗑️ Room deleted: ${roomId}`);
      }
    }
    
    socket.leave(roomId);
    console.log(`👋 ${user?.userName} left room: ${roomId}`);
  });

  // WebRTC Signaling: Offer
  socket.on('webrtc:offer', (data) => {
    const { roomId, to, offer } = data;
    console.log(`📤 Offer from ${socket.id} to ${to}`);
    io.to(to).emit('webrtc:offer', {
      from: socket.id,
      offer
    });
  });

  // WebRTC Signaling: Answer
  socket.on('webrtc:answer', (data) => {
    const { roomId, to, answer } = data;
    console.log(`📥 Answer from ${socket.id} to ${to}`);
    io.to(to).emit('webrtc:answer', {
      from: socket.id,
      answer
    });
  });

  // WebRTC Signaling: ICE Candidate
  socket.on('webrtc:ice-candidate', (data) => {
    const { roomId, to, candidate } = data;
    io.to(to).emit('webrtc:ice-candidate', {
      from: socket.id,
      candidate
    });
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    console.log(`❌ Socket disconnected: ${socket.id} (${user?.userName || 'unknown'})`);
    
    // Clean up from all rooms
    videoRooms.forEach((room, roomId) => {
      const wasInRoom = room.participants.some(p => p.socketId === socket.id);
      if (wasInRoom) {
        room.participants = room.participants.filter(p => p.socketId !== socket.id);
        
        // Notify others
        io.to(roomId).emit('room:participantLeft', {
          participant: { ...user, socketId: socket.id },
          allParticipants: room.participants
        });
        
        // Clean up empty rooms
        if (room.participants.length === 0) {
          videoRooms.delete(roomId);
        }
      }
    });
    
    connectedUsers.delete(socket.id);
    // Clean up reverse lookup
    if (user?.userId) {
      userSocketMap.delete(user.userId);
    }
  });
});

// API endpoint to create room (HTTP)
app.post('/api/rooms', (req, res) => {
  const { userId, userName, roomName } = req.body;
  const roomId = roomName || `room-${Date.now()}`;
  
  videoRooms.set(roomId, {
    participants: [],
    createdAt: new Date()
  });
  
  res.json({ success: true, roomId, roomName: roomId });
});

// API endpoint to get room info
app.get('/api/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = videoRooms.get(roomId);
  
  if (!room) {
    return res.status(404).json({ success: false, error: 'Room not found' });
  }
  
  res.json({ success: true, roomId, participants: room.participants });
});

// ── Serve built frontend in production ──────────────────────────────────────
const distPath = path.join(process.cwd(), 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  // SPA catch-all: serve index.html for any non-API route
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.sendFile(path.join(distPath, 'index.html'));
  });
  console.log('📂 Serving static frontend from /dist');
}

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log('📡 WebRTC Signaling Server ready (Socket.IO)');
  console.log('Available endpoints:');
  console.log('  POST /api/twilio/token - Generate video call token');
  console.log('  POST /api/twilio/rooms - List active rooms');
  console.log('  GET /api/twilio/rooms/:roomSid/participants - List room participants');
  console.log('  POST /api/cv/emotion - Analyze emotions from an image');
  console.log('  POST /api/cv/emotion/batch - Analyze emotions from 2-3 images and aggregate');
  console.log('  POST /api/audio/emotion - Analyze emotions from audio (Hugging Face SER)');
  console.log('  POST /api/emotion/text - Analyze emotions from text (Hugging Face)');
  console.log('  POST /api/hf/chat - Hugging Face Router (OpenAI-compatible) chat completions');
  if (HF_TOKEN) {
    console.log(`HF image model: ${HF_IMAGE_MODEL}`);
    console.log(`HF audio model: ${HF_AUDIO_MODEL}`);
    console.log(`HF text model: ${HF_TEXT_MODEL}`);
  }
});

/**
 * POST /api/audio/emotion
 * Body: multipart/form-data with a single 'audio' field (webm/wav/mp3 blob)
 * Routes the audio to a Hugging Face Speech Emotion Recognition (SER) model.
 * Returns the top detected vocal emotion and confidence scores.
 */
app.post('/api/audio/emotion', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No audio file uploaded' });
    }
    if (!HF_TOKEN) {
      fs.unlink(req.file.path, () => {});
      return res.status(500).json({ success: false, error: 'Missing HF_TOKEN or HUGGINGFACE_API_KEY' });
    }

    const audioBuffer = fs.readFileSync(req.file.path);
    fs.unlink(req.file.path, () => {}); // clean up temp file

    const modelName = req.body.model || HF_AUDIO_MODEL;

    const resp = await fetch(`https://router.huggingface.co/hf-inference/models/${encodeURIComponent(modelName)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_TOKEN}`,
        'Content-Type': 'audio/webm',
      },
      body: audioBuffer,
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error('HF audio emotion error:', data);
      return res.status(resp.status).json({ success: false, error: data?.error || 'HF audio inference failed' });
    }

    // HF audio-classification returns [{label, score}, ...]
    const arr = Array.isArray(data) ? data : [];
    const candidates = Array.isArray(arr[0]) ? arr[0] : arr;
    const top = candidates && candidates.length ? candidates.reduce((a, b) => (a.score >= b.score ? a : b)) : null;

    console.log(`🎙️ Audio emotion: ${top?.label} (${(top?.score * 100).toFixed(1)}%)`);
    return res.json({ success: true, model: modelName, candidates, top });
  } catch (error) {
    if (req.file) fs.unlink(req.file.path, () => {});
    console.error('Error in /api/audio/emotion:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/emotion/text
 * Body: { text: string, model?: string }
 * Uses Hugging Face text-classification model to detect emotion.
 */
app.post('/api/emotion/text', async (req, res) => {
  try {
    const { text, model } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing required field: text' });
    }
    if (!HF_TOKEN) {
      return res.status(500).json({ success: false, error: 'Missing HF_TOKEN or HUGGINGFACE_API_KEY' });
    }
    const modelName = model || HF_TEXT_MODEL;

    const resp = await fetch(`https://router.huggingface.co/hf-inference/models/${encodeURIComponent(modelName)}` , {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ inputs: text })
    });

    const data = await resp.json();
    if (!resp.ok) {
      return res.status(resp.status).json({ success: false, error: data?.error || 'Hugging Face inference failed' });
    }

    // HF text-classification can return [{label, score}, ...] or [[{label, score}, ...]]
    const arr = Array.isArray(data) ? data : [];
    const candidates = Array.isArray(arr[0]) ? arr[0] : arr;
    const top = candidates && candidates.length ? candidates.reduce((a, b) => (a.score >= b.score ? a : b)) : null;

    return res.json({ success: true, model: modelName, candidates, top });
  } catch (error) {
    console.error('Error in /api/emotion/text:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/hf/chat
 * Body: { model: string, messages: Array<{role, content}>, options? }
 * Proxies to Hugging Face Router (OpenAI-compatible) chat completions endpoint.
 */
app.post('/api/hf/chat', async (req, res) => {
  try {
    if (!HF_TOKEN) {
      return res.status(500).json({ success: false, error: 'Missing HF_TOKEN or HUGGINGFACE_API_KEY' });
    }

    const { model = 'moonshotai/Kimi-K2-Instruct-0905', messages = [], ...rest } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, error: 'messages array is required' });
    }

    const resp = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages, ...rest }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return res.status(resp.status).json({ success: false, error: data?.error || 'HF Router request failed', raw: data });
    }
    return res.json({ success: true, ...data });
  } catch (error) {
    console.error('Error in /api/hf/chat:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
