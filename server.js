// KIUT SmartLib Pass — backend for Render
// Serves the check-in / check-out / dashboard pages and exposes a small
// JSON API backed by Supabase.

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Allow your Netlify frontend (or any origin, for demo purposes) to call this API.
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------- WebAuthn (phone fingerprint) config ----------
// RP_ID must be the bare domain of the page that calls navigator.credentials.*
// e.g. "smart-lib1.netlify.app" (no https://, no path).
// RP_ORIGIN must be the full origin, e.g. "https://smart-lib1.netlify.app".
const RP_NAME = 'KIUT SmartLib Pass';
const RP_ID = process.env.RP_ID || 'smart-lib1.netlify.app';
const RP_ORIGIN = process.env.RP_ORIGIN || `https://${RP_ID}`;

// Demo-only in-memory challenge store (keyed by reg_number).
// A production build should persist this in Supabase with an expiry.
const challengeStore = new Map();

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

// ---------- WebAuthn: fingerprint registration ----------

// Step 1: server hands out a challenge + options for navigator.credentials.create()
app.post('/api/webauthn/register/options', async (req, res) => {
  const { reg_number, name } = req.body;
  if (!reg_number || !name) {
    return res.status(400).json({ error: 'reg_number and name are required' });
  }

  // Find or create the student
  let { data: student } = await supabase
    .from('students')
    .select('*')
    .eq('reg_number', reg_number)
    .single();

  if (!student) {
    const initials = name.trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join('');
    const { data: newStudent, error: insertErr } = await supabase
      .from('students')
      .insert({ reg_number, name, initials })
      .select()
      .single();
    if (insertErr) return res.status(500).json({ error: insertErr.message });
    student = newStudent;
  }

  const { data: existingCreds } = await supabase
    .from('webauthn_credentials')
    .select('credential_id, transports')
    .eq('student_id', student.id);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: reg_number,
    userDisplayName: name,
    attestationType: 'none',
    excludeCredentials: (existingCreds || []).map(c => ({
      id: c.credential_id,
      transports: c.transports || undefined,
    })),
    authenticatorSelection: {
      authenticatorAttachment: 'platform', // use the phone's built-in sensor
      userVerification: 'required',
      residentKey: 'preferred',
    },
  });

  challengeStore.set(reg_number, options.challenge);
  res.json(options);
});

// Step 2: verify the attestation the phone produced, store the public key
app.post('/api/webauthn/register/verify', async (req, res) => {
  const { reg_number, credential } = req.body;
  const expectedChallenge = challengeStore.get(reg_number);
  if (!expectedChallenge) {
    return res.status(400).json({ error: 'No registration in progress for this reg_number' });
  }

  try {
    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ verified: false, error: 'Could not verify fingerprint' });
    }

    const { data: student } = await supabase
      .from('students')
      .select('id')
      .eq('reg_number', reg_number)
      .single();

    const info = verification.registrationInfo;
    const { error: insertErr } = await supabase.from('webauthn_credentials').insert({
      student_id: student.id,
      credential_id: info.credential.id,
      public_key: Buffer.from(info.credential.publicKey).toString('base64url'),
      counter: info.credential.counter,
      device_type: info.credentialDeviceType,
      backed_up: info.credentialBackedUp,
      transports: credential.response?.transports || [],
    });

    if (insertErr) return res.status(500).json({ error: insertErr.message });

    challengeStore.delete(reg_number);
    res.json({ verified: true });
  } catch (err) {
    res.status(400).json({ verified: false, error: err.message });
  }
});

// ---------- WebAuthn: fingerprint login ----------

app.post('/api/webauthn/login/options', async (req, res) => {
  const { reg_number } = req.body;
  if (!reg_number) return res.status(400).json({ error: 'reg_number is required' });

  const { data: student } = await supabase
    .from('students')
    .select('id')
    .eq('reg_number', reg_number)
    .single();

  if (!student) return res.status(404).json({ error: 'No account found for this registration number' });

  const { data: creds } = await supabase
    .from('webauthn_credentials')
    .select('credential_id, transports')
    .eq('student_id', student.id);

  if (!creds || creds.length === 0) {
    return res.status(404).json({ error: 'No fingerprint registered for this ID yet' });
  }

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'required',
    allowCredentials: creds.map(c => ({
      id: c.credential_id,
      transports: c.transports || undefined,
    })),
  });

  challengeStore.set(reg_number, options.challenge);
  res.json(options);
});

app.post('/api/webauthn/login/verify', async (req, res) => {
  const { reg_number, credential } = req.body;
  const expectedChallenge = challengeStore.get(reg_number);
  if (!expectedChallenge) {
    return res.status(400).json({ error: 'No login in progress for this reg_number' });
  }

  const { data: student } = await supabase
    .from('students')
    .select('id, name')
    .eq('reg_number', reg_number)
    .single();
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const { data: savedCred } = await supabase
    .from('webauthn_credentials')
    .select('*')
    .eq('student_id', student.id)
    .eq('credential_id', credential.id)
    .single();

  if (!savedCred) return res.status(400).json({ error: 'Unrecognised credential for this ID' });

  try {
    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: savedCred.credential_id,
        publicKey: Buffer.from(savedCred.public_key, 'base64url'),
        counter: Number(savedCred.counter),
        transports: savedCred.transports || undefined,
      },
    });

    if (!verification.verified) {
      return res.status(400).json({ verified: false, error: 'Fingerprint did not match' });
    }

    await supabase
      .from('webauthn_credentials')
      .update({ counter: verification.authenticationInfo.newCounter })
      .eq('id', savedCred.id);

    challengeStore.delete(reg_number);
    res.json({ verified: true, name: student.name, time: fmtTime(new Date()) });
  } catch (err) {
    res.status(400).json({ verified: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`KIUT SmartLib Pass server running on port ${PORT}`));