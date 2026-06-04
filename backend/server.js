require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Clients ────────────────────────────────────────────────────────────────
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Supabase è opzionale — non crasha se le variabili mancano
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  console.log('[supabase] Client initialized');
} else {
  console.warn('[supabase] Missing env vars — session save/load disabled');
}

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function getTranscriptSupadata(videoId) {
  const apiKey = process.env.SUPADATA_API_KEY;
  if (!apiKey) throw new Error('SUPADATA_API_KEY not configured');

  const url = `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=false`;
  const res = await fetch(url, {
    headers: { 'x-api-key': apiKey }
  });
  const data = await res.json();

  if (!res.ok) throw new Error(data.message || data.error || 'Supadata error');
  if (!data.content || !data.content.length) throw new Error('No transcript content from Supadata');

  return data.content.map(seg => ({
    text: (seg.text || '').trim(),
    start: typeof seg.offset === 'number' ? Math.round(seg.offset / 100) / 10 : 0,
    duration: typeof seg.duration === 'number' ? Math.round(seg.duration / 100) / 10 : 2
  })).filter(seg => seg.text);
}

async function getTranscriptGemini(videoUrl) {
  const prompt = `You are a transcript extractor. Watch this YouTube video and produce a precise transcript in JSON format.
Return ONLY a valid JSON array, no markdown, no explanation.
Each element must have:
- "text": the spoken words (string)
- "start": approximate start time in seconds (number)
- "duration": approximate duration in seconds (number)

Example: [{"text":"Hello everyone","start":0,"duration":2.1},{"text":"Welcome back","start":2.1,"duration":1.8}]

Video URL: ${videoUrl}`;

  const response = await genAI.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });
  const raw = response.text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(raw);
  // Normalizza i campi — Gemini a volte usa text_content, text_text, ecc.
  return parsed.map(seg => ({
    text: (seg.text || seg.text_content || seg.text_text || seg.content || seg.transcript || '').trim(),
    start: typeof seg.start === 'number' ? seg.start : 0,
    duration: typeof seg.duration === 'number' ? seg.duration : 2
  })).filter(seg => seg.text);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({
  status: 'ok',
  timestamp: new Date().toISOString(),
  supabase: supabase ? 'connected' : 'not configured'
}));

// GET /api/transcript?url=...
app.get('/api/transcript', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  let transcript = null;
  let source = null;

  // Tentativo 1: Supadata
  try {
    console.log(`[transcript] Trying Supadata for ${videoId}...`);
    transcript = await getTranscriptSupadata(videoId);
    source = 'youtube';
    console.log(`[transcript] ✓ Supadata: ${transcript.length} segments`);
  } catch (err) {
    console.warn(`[transcript] ✗ Supadata failed: ${err.message}`);
  }

  if (!transcript) {
    try {
      console.log(`[transcript] Trying Gemini fallback...`);
      const fullUrl = `https://www.youtube.com/watch?v=${videoId}`;
      transcript = await getTranscriptGemini(fullUrl);
      source = 'gemini';
      console.log(`[transcript] ✓ Gemini: ${transcript.length} segments`);
    } catch (err) {
      console.error(`[transcript] ✗ Gemini also failed: ${err.message}`);
      return res.status(500).json({ error: 'Could not extract transcript from this video', details: err.message });
    }
  }

  res.json({ videoId, source, transcript });
});

// POST /api/exercises
app.post('/api/exercises', async (req, res) => {
  const { transcript, type = 'fill_blank' } = req.body;
  if (!transcript || !Array.isArray(transcript)) {
    return res.status(400).json({ error: 'Missing or invalid transcript' });
  }

  const fullText = transcript.map(s => s.text).join(' ');

  const prompts = {
    fill_blank: `You are an English speaking coach. Based on this transcript, create 5 fill-in-the-blank exercises focused on natural spoken English phrases.
For each exercise:
- Remove 1-2 key words from a sentence
- The blanks should target common collocations, phrasal verbs, or natural spoken patterns
- Provide the answer

Return ONLY valid JSON, no markdown:
{"exercises":[{"sentence":"I ___ to the store yesterday","blank":"went","context":"past simple - common verb"},...]}`,

    dictation: `You are an English speaking coach. Select 6 short sentences from this transcript that are great for dictation practice (clear, natural, not too long).
Return ONLY valid JSON, no markdown:
{"exercises":[{"text":"Have you ever been to London?","difficulty":"easy"},...]}`,

    loop_drill: `You are an English speaking coach. Identify 5 sentences or phrases from this transcript ideal for loop shadowing (rhythmically interesting, natural stress patterns, useful in real conversation).
Return ONLY valid JSON, no markdown:
{"exercises":[{"text":"I was wondering if you could help me","reason":"polite request pattern","stress_words":["wondering","help"]},...]}`,
  };

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `${prompts[type] || prompts.fill_blank}\n\nTranscript:\n${fullText.substring(0, 3000)}`
      }]
    });

    const raw = message.content[0].text.replace(/```json|```/g, '').trim();
    const data = JSON.parse(raw);
    res.json({ type, ...data });
  } catch (err) {
    console.error('[exercises] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate exercises', details: err.message });
  }
});

// POST /api/sessions
app.post('/api/sessions', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured yet' });

  const { student_name, video_url, video_id, video_title, transcript, notes } = req.body;
  if (!student_name || !video_url) {
    return res.status(400).json({ error: 'Missing student_name or video_url' });
  }

  const { data, error } = await supabase
    .from('shadowing_sessions')
    .insert([{ student_name, video_url, video_id, video_title, transcript, notes, created_at: new Date().toISOString() }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, session: data });
});

// GET /api/sessions?student=...
app.get('/api/sessions', async (req, res) => {
  if (!supabase) return res.json({ sessions: [] });

  const { student } = req.query;
  let query = supabase.from('shadowing_sessions').select('*').order('created_at', { ascending: false });
  if (student) query = query.eq('student_name', student);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ sessions: data });
});

// GET /api/students
app.get('/api/students', async (req, res) => {
  if (!supabase) return res.json({ students: [] });

  const { data, error } = await supabase
    .from('shadowing_sessions')
    .select('student_name')
    .order('student_name');

  if (error) return res.status(500).json({ error: error.message });
  const unique = [...new Set(data.map(r => r.student_name))];
  res.json({ students: unique });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Shadowing backend running on port ${PORT}`));
