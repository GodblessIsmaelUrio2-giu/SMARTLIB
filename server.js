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
  try {
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
  } catch (err) {
    console.error('checkin error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Check a student out
app.post('/api/checkout', async (req, res) => {
  try {
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
  } catch (err) {
    console.error('checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Live log for the dashboard table
app.get('/api/logs', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('v_entry_log')
      .select('*')
      .limit(50);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    console.error('logs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Dashboard summary stats
app.get('/api/stats', async (req, res) => {
  try {
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
  } catch (err) {
    console.error('stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Student's own history + profile summary (used by profile.html)
app.get('/api/students/:reg_number/history', async (req, res) => {
  try {
    const { reg_number } = req.params;

    const { data: student, error: studentErr } = await supabase
      .from('students')
      .select('*')
      .eq('reg_number', reg_number)
      .single();

    if (studentErr || !student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const { data: history, error: historyErr } = await supabase
      .from('entry_logs')
      .select('*')
      .eq('student_id', student.id)
      .order('time_in', { ascending: false })
      .limit(50);

    if (historyErr) return res.status(500).json({ error: historyErr.message });

    const currentlyInside = (history || []).some(h => h.status === 'inside');

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const visitsThisMonth = (history || []).filter(
      h => new Date(h.time_in) >= startOfMonth
    ).length;

    const completed = (history || []).filter(h => h.time_out);
    let avgSession = '—';
    if (completed.length > 0) {
      const totalMs = completed.reduce(
        (sum, h) => sum + (new Date(h.time_out) - new Date(h.time_in)),
        0
      );
      const avgMins = Math.round(totalMs / completed.length / 60000);
      avgSession = avgMins >= 60
        ? `${Math.floor(avgMins / 60)}h ${avgMins % 60}m`
        : `${avgMins}m`;
    }

    const { count: credCount } = await supabase
      .from('webauthn_credentials')
      .select('*', { count: 'exact', head: true })
      .eq('student_id', student.id);

    res.json({
      student: {
        name: student.name,
        initials: student.initials,
        reg_number: student.reg_number,
      },
      currently_inside: currentlyInside,
      visits_this_month: visitsThisMonth,
      avg_session: avgSession,
      has_fingerprint: (credCount ?? 0) > 0,
      history,
    });
  } catch (err) {
    console.error('student history error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Librarian login — simple passcode check, no fingerprint required
app.post('/api/librarian/login', (req, res) => {
  const { passcode } = req.body;
  const expected = process.env.LIBRARIAN_PASSCODE;

  if (!expected) {
    return res.status(500).json({ ok: false, error: 'Librarian passcode not configured on server' });
  }
  if (passcode !== expected) {
    return res.status(401).json({ ok: false, error: 'Incorrect passcode' });
  }

  // Demo-grade token — good enough for a shared kiosk device, not a real auth system.
  const token = Buffer.from(`librarian:${Date.now()}`).toString('base64url');
  res.json({ ok: true, token });
});



// ---------- WebAuthn: fingerprint registration ----------

// Step 1: server hands out a challenge + options for navigator.credentials.create()
app.post('/api/webauthn/register/options', async (req, res) => {
  console.log('register/options hit:', req.body?.reg_number);
  try {
    const { reg_number, name } = req.body;
    if (!reg_number || !name) {
      return res.status(400).json({ error: 'reg_number and name are required' });
    }

    // Find or create the student
    let { data: student, error: findErr } = await supabase
      .from('students')
      .select('*')
      .eq('reg_number', reg_number)
      .single();

    if (findErr && findErr.code !== 'PGRST116') {
      // PGRST116 = no rows found, which is fine here (we'll create one).
      // Any other error is a real problem.
      console.error('student lookup error:', findErr);
      return res.status(500).json({ error: findErr.message });
    }

    if (!student) {
      const initials = name.trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join('');
      const { data: newStudent, error: insertErr } = await supabase
        .from('students')
        .insert({ reg_number, name, initials })
        .select()
        .single();
      if (insertErr) {
        console.error('student insert error:', insertErr);
        return res.status(500).json({ error: insertErr.message });
      }
      student = newStudent;
    }

    const { data: existingCreds, error: credsErr } = await supabase
      .from('webauthn_credentials')
      .select('credential_id, transports')
      .eq('student_id', student.id);

    if (credsErr) {
      // Most likely cause: the webauthn_credentials table doesn't exist yet
      // (Webauthn_schema.sql was never run in Supabase).
      console.error('webauthn_credentials lookup error:', credsErr);
      return res.status(500).json({ error: `webauthn_credentials query failed: ${credsErr.message}` });
    }

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: new TextEncoder().encode(student.id),
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
        residentKey: 'discouraged',
      },
    });

    challengeStore.set(reg_number, options.challenge);
    res.json(options);
  } catch (err) {
    console.error('register/options error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Step 2: verify the attestation the phone produced, store the public key
app.post('/api/webauthn/register/verify', async (req, res) => {
  try {
    const { reg_number, credential } = req.body;
    const expectedChallenge = challengeStore.get(reg_number);
    if (!expectedChallenge) {
      return res.status(400).json({ error: 'No registration in progress for this reg_number' });
    }

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: RP_ORIGIN,
      expectedRPID: RP_ID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ verified: false, error: 'Could not verify fingerprint' });
    }

    const { data: student, error: studentErr } = await supabase
      .from('students')
      .select('id')
      .eq('reg_number', reg_number)
      .single();

    if (studentErr || !student) {
      return res.status(404).json({ verified: false, error: 'Student not found' });
    }

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
    console.error('register/verify error:', err);
    res.status(400).json({ verified: false, error: err.message });
  }
});

// ---------- WebAuthn: fingerprint login ----------

app.post('/api/webauthn/login/options', async (req, res) => {
  try {
    const { reg_number } = req.body;
    if (!reg_number) return res.status(400).json({ error: 'reg_number is required' });

    const { data: student, error: studentErr } = await supabase
      .from('students')
      .select('id')
      .eq('reg_number', reg_number)
      .single();

    if (studentErr || !student) {
      return res.status(404).json({ error: 'No account found for this registration number' });
    }

    const { data: creds, error: credsErr } = await supabase
      .from('webauthn_credentials')
      .select('credential_id, transports')
      .eq('student_id', student.id);

    if (credsErr) {
      console.error('webauthn_credentials lookup error:', credsErr);
      return res.status(500).json({ error: `webauthn_credentials query failed: ${credsErr.message}` });
    }

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
  } catch (err) {
    console.error('login/options error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/webauthn/login/verify', async (req, res) => {
  try {
    const { reg_number, credential } = req.body;
    const expectedChallenge = challengeStore.get(reg_number);
    if (!expectedChallenge) {
      return res.status(400).json({ error: 'No login in progress for this reg_number' });
    }

    const { data: student, error: studentErr } = await supabase
      .from('students')
      .select('id, name')
      .eq('reg_number', reg_number)
      .single();
    if (studentErr || !student) return res.status(404).json({ error: 'Student not found' });

    const { data: savedCred, error: credErr } = await supabase
      .from('webauthn_credentials')
      .select('*')
      .eq('student_id', student.id)
      .eq('credential_id', credential.id)
      .single();

    if (credErr || !savedCred) return res.status(400).json({ error: 'Unrecognised credential for this ID' });

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
    console.error('login/verify error:', err);
    res.status(400).json({ verified: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`KIUT SmartLib Pass server running on port ${PORT}`));