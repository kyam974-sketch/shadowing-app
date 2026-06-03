require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { YoutubeTranscript } = require('youtube-transcript');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Clients ────────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function getTranscriptYoutube(videoId) {
  const raw = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
  return raw.map(item => ({
    text: item.text.replace(/\n/g, ' ').trim(),
    start: Math.round(item.offset / 1000 * 10) / 10,  // secondi con 1 decimale
    duration: Math.round(item.duration / 1000 * 10) / 10
  }));
}

async function getTranscriptGemini(videoUrl) {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const prompt = `You are a transcript extractor. Watch this YouTube video and produce a precise transcript in JSON format.
Return ONLY a valid JSON array, no markdown, no explanation.
Each element must have:
- "text": the spoken words (string)
- "start": approximate start time in seconds (number)
- "duration": approximate duration in seconds (number)

Example: [{"text":"Hello everyone","start":0,"duration":2.1},{"text":"Welcome back","start":2.1,"duration":1.8}]

Video URL: ${videoUrl}`;

  const result = await model.generateContent([{ text: prompt }]);
  const raw = result.response.text().replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// GET /api/transcript?url=...
app.get('/api/transcript', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  let transcript = null;
  let source = null;

  // Tentativo 1: youtube-transcript
  try {
    console.log(`[transcript] Trying youtube-transcript for ${videoId}...`);
    transcript = await getTranscriptYoutube(videoId);
    source = 'youtube';
    console.log(`[transcript] ✓ youtube-transcript: ${transcript.length} segments`);
  } catch (err) {
    console.warn(`[transcript] ✗ youtube-transcript failed: ${err.message}`);
  }

  // Fallback: Gemini
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
// Body: { transcript: [...], type: "fill_blank" | "dictation" | "loop_drill" }
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
{"exercises":[{"sentence":"I ___ to the store yesterday","blank":"went","context":"past simple - common verb"},...]}`  ,

    dictation: `You are an English speaking coach. Select 6 short sentences from this transcript that are great for dictation practice (clear, natural, not too long).
Return ONLY valid JSON, no markdown:
{"exercises":[{"text":"Have you ever been to London?","difficulty":"easy"},...]}`  ,

    loop_drill: `You are an English speaking coach. Identify 5 sentences or phrases from this transcript ideal for loop shadowing (rhythmically interesting, natural stress patterns, useful in real conversation).
Return ONLY valid JSON, no markdown:
{"exercises":[{"text":"I was wondering if you could help me","reason":"polite request pattern","stress_words":["wondering","help"]},...]}`
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
// Body: { student_name, video_url, video_id, video_title, transcript, notes }
app.post('/api/sessions', async (req, res) => {
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
  const { student } = req.query;
  let query = supabase.from('shadowing_sessions').select('*').order('created_at', { ascending: false });
  if (student) query = query.eq('student_name', student);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ sessions: data });
});

// GET /api/students
app.get('/api/students', async (req, res) => {
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
