# 🎙 Shadow Lab

English shadowing app for private lessons — YouTube video + synchronized karaoke transcript, speed control, loop drill, AI-generated exercises, session history.

## Stack

| Layer | Service |
|-------|---------|
| Frontend | Vercel (static HTML) |
| Backend | Render (Node/Express) |
| Database | Supabase |
| AI exercises | Anthropic Claude |
| Transcript fallback | Google Gemini |

---

## Setup

### 1. Supabase — create table

Run this SQL in the Supabase SQL editor:

```sql
create table shadowing_sessions (
  id uuid primary key default gen_random_uuid(),
  student_name text not null,
  video_url text not null,
  video_id text,
  video_title text,
  transcript jsonb,
  notes text,
  created_at timestamptz default now()
);

create index on shadowing_sessions (student_name);
create index on shadowing_sessions (created_at desc);
```

### 2. Backend — deploy on Render

1. Create a new **Web Service** on [render.com](https://render.com)
2. Connect to this GitHub repo
3. Set **Root Directory** → `backend`
4. Set **Build Command** → `npm install`
5. Set **Start Command** → `npm start`
6. Add these **Environment Variables**:

| Key | Value |
|-----|-------|
| `ANTHROPIC_API_KEY` | Your Anthropic key |
| `GEMINI_API_KEY` | Your Gemini key |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Your Supabase service role key |
| `FRONTEND_URL` | Your Vercel URL (after deploy) |
| `PORT` | `3000` |

7. Copy the Render URL (e.g. `https://shadowing-app-xxxx.onrender.com`)

### 3. Frontend — set backend URL

In `frontend/index.html`, find this line:

```js
const BACKEND = 'BACKEND_URL_PLACEHOLDER';
```

Replace `BACKEND_URL_PLACEHOLDER` with your Render URL.

### 4. Frontend — deploy on Vercel

1. Create a new project on [vercel.com](https://vercel.com)
2. Connect to this GitHub repo
3. Set **Root Directory** → `frontend`
4. Deploy

---

## Usage

1. Enter student name (top right)
2. Paste a YouTube URL and click **Load**
3. Transcript appears on the right — click any line to jump to it
4. Use speed controls (×0.5, ×0.75, ×1) for shadowing practice
5. Click a line → **Loop line** to repeat it N times
6. Click **Generate** for AI exercises (fill blank / dictation / loop drill)
7. Click **+ Save** to save the session to Supabase

## Transcript sources

- Primary: YouTube captions (via `youtube-transcript` npm package)
- Fallback: Gemini 1.5 Flash audio analysis (for videos without captions)
