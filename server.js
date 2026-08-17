require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { pool, initDb } = require('./db');
const { issueSession, requireAdmin, clearSession } = require('./auth');
const { sendEmail } = require('./email');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function genRefCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = 'HH-';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Public: site config ----------
app.get('/api/config', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT house_name, tagline, nightly_rate, cleaning_fee, max_guests FROM site_config WHERE id = 1'
  );
  res.json(rows[0]);
});

// ---------- Public: ledger (dates only, no guest info) ----------
app.get('/api/ledger', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT checkin, checkout, status FROM bookings
     WHERE status IN ('confirmed', 'blocked') AND checkout >= CURRENT_DATE
     ORDER BY checkin ASC`
  );
  res.json(rows);
});

// ---------- Public: create a booking ----------
app.post('/api/bookings', async (req, res) => {
  const { name, email, phone, notes, checkin, checkout, guests } = req.body || {};
  if (!name || !email || !checkin || !checkout) {
    return res.status(400).json({ error: 'Name, email, check-in, and check-out are required.' });
  }
  if (checkout <= checkin) {
    return res.status(400).json({ error: 'Check-out must be after check-in.' });
  }

  const cfgRes = await pool.query(
    'SELECT max_guests, nightly_rate, cleaning_fee, owner_email, house_name FROM site_config WHERE id = 1'
  );
  const cfg = cfgRes.rows[0];

  if (guests && guests > cfg.max_guests) {
    return res.status(400).json({ error: `This house sleeps ${cfg.max_guests} max.` });
  }

  const refCode = genRefCode();
  try {
    await pool.query(
      `INSERT INTO bookings (ref_code, name, email, phone, notes, checkin, checkout, guests, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed')`,
      [refCode, name, email, phone || null, notes || null, checkin, checkout, guests || null]
    );
  } catch (e) {
    if (e.code === '23P01') {
      // Postgres exclusion constraint violation = overlapping dates
      return res.status(409).json({ error: 'Those dates were just booked. Please choose different dates.' });
    }
    console.error(e);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }

  sendEmail({
    to: email,
    subject: `Booking request received — ${refCode}`,
    html: `<p>Hi ${escapeHtml(name)},</p>
           <p>We received your request for <b>${escapeHtml(cfg.house_name)}</b>,
           ${checkin} to ${checkout}.</p>
           <p>Reference code: <b>${refCode}</b></p>
           <p>The owner will follow up directly to confirm.</p>`
  });

  if (cfg.owner_email) {
    sendEmail({
      to: cfg.owner_email,
      subject: `New booking request — ${refCode}`,
      html: `<p><b>${escapeHtml(name)}</b> (${escapeHtml(email)}${phone ? ', ' + escapeHtml(phone) : ''})
             requested ${checkin} → ${checkout}, ${guests || '?'} guests.</p>
             <p>Notes: ${escapeHtml(notes) || '—'}</p>
             <p>Reference: ${refCode}</p>`
    });
  }

  res.json({ ok: true, refCode });
});

// ---------- Admin: auth ----------
app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body || {};
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'Server is not configured with an admin password.' });
  }
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  issueSession(res);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));

// ---------- Admin: bookings ----------
app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM bookings ORDER BY checkin DESC');
  res.json(rows);
});

app.patch('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  if (!['confirmed', 'cancelled', 'blocked'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  try {
    await pool.query('UPDATE bookings SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23P01') {
      return res.status(409).json({ error: 'That would overlap another active booking.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.delete('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM bookings WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/admin/blocks', requireAdmin, async (req, res) => {
  const { checkin, checkout } = req.body || {};
  if (!checkin || !checkout || checkout <= checkin) {
    return res.status(400).json({ error: 'Invalid date range.' });
  }
  try {
    await pool.query(
      `INSERT INTO bookings (name, checkin, checkout, status) VALUES ('Owner block', $1, $2, 'blocked')`,
      [checkin, checkout]
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23P01') {
      return res.status(409).json({ error: 'Overlaps an existing booking or block.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---------- Admin: site config ----------
app.put('/api/admin/config', requireAdmin, async (req, res) => {
  const { houseName, tagline, nightlyRate, cleaningFee, maxGuests, ownerEmail } = req.body || {};
  await pool.query(
    `UPDATE site_config
     SET house_name = $1, tagline = $2, nightly_rate = $3, cleaning_fee = $4, max_guests = $5, owner_email = $6
     WHERE id = 1`,
    [houseName, tagline, nightlyRate, cleaningFee, maxGuests, ownerEmail || null]
  );
  res.json({ ok: true });
});

app.get('/api/admin/config-full', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM site_config WHERE id = 1');
  res.json(rows[0]);
});

// ---------- Fallback to the SPA ----------
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
