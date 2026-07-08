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
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200
}));
app.options('*', cors());
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

  const { customPhrase } = req.body;
  const fullText = transcript.map(s => s.text).join(' ');

  // Tipo speciale: analizza una singola parola/frase custom
  if (type === 'vocabulary_single') {
    if (!customPhrase) return res.status(400).json({ error: 'Missing customPhrase' });
    try {
      const message = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `You are an English coach for A1 adult learners. Analyze this word or phrase: "${customPhrase}"
Give a simple English definition. Search carefully in the transcript for this phrase or similar wording (it may be split across lines). If found, use the exact transcript text as example. If not found verbatim, create a natural example sentence in the same style and context.
Transcript: "${fullText.substring(0,1500)}"
Return ONLY valid JSON: {"exercises":[{"word":"${customPhrase}","definition":"simple definition","example":"example sentence using the phrase naturally","transcript_example":"exact quote from transcript if found, otherwise same as example"}]}`
        }]
      });
      const raw = message.content[0].text.replace(/```json|```/g, '').trim();
      const data = JSON.parse(raw);
      return res.json({ type: 'vocabulary_single', ...data });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const prompts = {

    fill_blank: `You are an English coach for A1 adult learners. From this transcript create 5 fill-in-the-blank exercises using real sentences from the video. Target natural spoken patterns, common verbs, collocations. Remove 1-2 words per sentence. Keep sentences short and clear for A1 level.
Return ONLY valid JSON, no markdown: {"exercises":[{"sentence":"I ___ to the store yesterday","blank":"went","context":"past simple - common verb"}]}`,

    dictation: `You are an English coach for A1 adult learners. Select 5 sentences or short phrases from this transcript ideal for dictation practice. They can be dramatic, colloquial, or emotional — just clear enough to write down. Max 15 words each. If the transcript has fragmented lines, combine adjacent fragments into one natural sentence.
Return ONLY valid JSON, no markdown: {"exercises":[{"text":"You are so gonna regret crossing me.","difficulty":"medium","focus":"future with going to"}]}`,

    loop_drill: `You are an English coach for A1 adult learners. Identify 5 phrases from this transcript ideal for loop shadowing — rhythmically interesting, natural stress, useful in real life. Must be exact quotes from the transcript.
Return ONLY valid JSON, no markdown: {"exercises":[{"text":"I was wondering if you could help me","reason":"polite request","stress_words":["wondering","help"]}]}`,

    true_false: `You are an English coach for A1 adult learners. Create 6 true/false statements about the content of this transcript. Mix true and false. Keep language very simple.
Return ONLY valid JSON, no markdown: {"exercises":[{"statement":"The professor teaches criminal law.","answer":true,"correction":null},{"statement":"The class is called Law 200.","answer":false,"correction":"It is called Law 100."}]}`,

    sentence_ordering: `You are an English coach for A1 adult learners. Take 4 short sentences from this transcript and scramble the words. Student must reorder them. Use only simple short sentences.
Return ONLY valid JSON, no markdown: {"exercises":[{"words":["store","I","the","went","to"],"answer":"I went to the store"}]}`,

    vocabulary: `You are an English coach for A1 adult learners. Find 7 useful words or short phrases from this transcript. For each: simple English definition (no Italian), example sentence from the transcript.
Return ONLY valid JSON, no markdown: {"exercises":[{"word":"attorney","definition":"a lawyer who works in a court","example":"She works as a defense attorney.","transcript_example":"as a defense attorney I spend most of my time"}]}`,

    qa: `You are an English coach for A1 adult learners. Create 5 simple comprehension questions about this transcript. Student answers with short spoken responses. Questions must be answerable from the video. Very simple language only.
Return ONLY valid JSON, no markdown: {"exercises":[{"question":"What subject does the professor teach?","model_answer":"She teaches criminal law.","hint":"Listen for the name of the class"}]}`,

    grammar: `You are an English coach for A1 adult learners. Find ONE grammar structure used naturally in this transcript. Create 5 practice exercises based on real sentences. Focus on USE not rules — no grammar theory. Student hears the pattern and practices it.
Return ONLY valid JSON, no markdown: {"structure":"present simple","explanation":"Used for facts and routines — hear how it sounds naturally","exercises":[{"type":"complete","prompt":"She ___ (work) as his assistant.","answer":"works","transcript_line":"she worked as the second assistant"},{"type":"repeat","prompt":"Say this out loud: She works as his assistant.","answer":null}]}`,

    conversation: `You are an English coach for A1 adult learners. Create 4 conversation starter questions inspired by the themes of this transcript. Personal, easy to answer, A1 level. Goal: get the student speaking freely.
Return ONLY valid JSON, no markdown: {"exercises":[{"question":"Do you have a favorite TV show? What is it about?","theme":"entertainment","scaffold":"My favorite show is... It is about..."}]}`,

    pronunciation: `You are an English coach for A1 adult learners. Select 5 phrases from this transcript excellent for pronunciation practice. Focus on connected speech, word stress, or sounds difficult for Italian speakers. Simple explanations.
Return ONLY valid JSON, no markdown: {"exercises":[{"text":"I don't know what terrible things","focus":"weak forms: don't sounds like dən, what sounds like wət","tip":"Say it fast and smooth, not word by word"}]}`,
  };

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1500,
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

  const { student_name, video_url, video_id, video_title, transcript, notes, exercises } = req.body;
  if (!student_name || !video_url) {
    return res.status(400).json({ error: 'Missing student_name or video_url' });
  }

  const { data, error } = await supabase
    .from('shadowing_sessions')
    .insert([{ student_name, video_url, video_id, video_title, transcript, notes, exercises: exercises || null, created_at: new Date().toISOString() }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, session: data });
});

// PATCH /api/sessions/:id
app.patch('/api/sessions/:id', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  const { id } = req.params;
  const { notes, video_title, exercises } = req.body;
  const updates = {};
  if (notes !== undefined) updates.notes = notes;
  if (video_title !== undefined) updates.video_title = video_title;
  if (exercises !== undefined) updates.exercises = exercises;
  const { data, error } = await supabase
    .from('shadowing_sessions')
    .update(updates)
    .eq('id', id)
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
