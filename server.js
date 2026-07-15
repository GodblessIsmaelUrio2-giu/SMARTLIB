// KIUT SmartLib Pass — backend for Render
// Serves the check-in / check-out / dashboard pages and exposes a small
// JSON API backed by Supabase.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------- Helpers ----------
function fmtTime(d) {
  return new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// ---------- API ----------

// Check a student in
app.post('/api/checkin', async (req, res) => {
  const { reg_number } = req.body;
  if (!reg_number) return res.status(400).json({ error: 'reg_number is required' });

  const { data: student, error: studentErr } = await supabase
    .from('students')
    .select('*')
    .eq('reg_number', reg_number)
    .single();

  if (studentErr || !student) {
    return res.status(404).json({ granted: false, reason: 'Card not recognised — see librarian' });
  }

  // Simple baggage-flag demo rule: students already marked flagged stay flagged
  const { data: entry, error: entryErr } = await supabase
    .from('entry_logs')
    .insert({ student_id: student.id, status: 'inside' })
    .select()
    .single();

  if (entryErr) return res.status(500).json({ error: entryErr.message });

  res.json({
    granted: true,
    student: { name: student.name, initials: student.initials, reg_number: student.reg_number },
    time_in: fmtTime(entry.time_in),
  });
});

// Check a student out
app.post('/api/checkout', async (req, res) => {
  const { reg_number } = req.body;
  if (!reg_number) return res.status(400).json({ error: 'reg_number is required' });

  const { data: student, error: studentErr } = await supabase
    .from('students')
    .select('*')
    .eq('reg_number', reg_number)
    .single();

  if (studentErr || !student) {
    return res.status(404).json({ error: 'Card not recognised' });
  }

  // Find their most recent open ("inside") entry
  const { data: openEntry, error: openErr } = await supabase
    .from('entry_logs')
    .select('*')
    .eq('student_id', student.id)
    .eq('status', 'inside')
    .order('time_in', { ascending: false })
    .limit(1)
    .single();

  if (openErr || !openEntry) {
    return res.status(404).json({ error: 'No active session found for this student' });
  }

  const timeOut = new Date();
  const { error: updateErr } = await supabase
    .from('entry_logs')
    .update({ time_out: timeOut.toISOString(), status: 'checked_out' })
    .eq('id', openEntry.id);

  if (updateErr) return res.status(500).json({ error: updateErr.message });

  const sessionMs = timeOut - new Date(openEntry.time_in);
  const mins = Math.floor(sessionMs / 60000);
  const session = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;

  res.json({
    checked_out: true,
    student: { name: student.name, initials: student.initials, reg_number: student.reg_number },
    time_out: fmtTime(timeOut),
    session,
  });
});

// Live log for the dashboard table
app.get('/api/logs', async (req, res) => {
  const { data, error } = await supabase
    .from('v_entry_log')
    .select('*')
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Dashboard summary stats
app.get('/api/stats', async (req, res) => {
  const { count: activeInside } = await supabase
    .from('entry_logs')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'inside');

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { count: checkinsToday } = await supabase
    .from('entry_logs')
    .select('*', { count: 'exact', head: true })
    .gte('time_in', startOfDay.toISOString());

  const { count: flagged } = await supabase
    .from('entry_logs')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'flagged');

  res.json({
    active_inside: activeInside ?? 0,
    checkins_today: checkinsToday ?? 0,
    flagged: flagged ?? 0,
  });
});

app.get('/health', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`KIUT SmartLib Pass server running on port ${PORT}`));
