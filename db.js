const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  // Needed for the exclusion constraint below (date range overlap checks)
  await pool.query(`CREATE EXTENSION IF NOT EXISTS btree_gist;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      house_name TEXT NOT NULL DEFAULT 'Halyard House',
      tagline TEXT NOT NULL DEFAULT 'A weathered-shingle house on the edge of the tide.',
      nightly_rate NUMERIC NOT NULL DEFAULT 350,
      cleaning_fee NUMERIC NOT NULL DEFAULT 175,
      max_guests INTEGER NOT NULL DEFAULT 9,
      owner_email TEXT
    );
  `);
  await pool.query(`INSERT INTO site_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      ref_code TEXT UNIQUE,
      name TEXT,
      email TEXT,
      phone TEXT,
      notes TEXT,
      checkin DATE NOT NULL,
      checkout DATE NOT NULL,
      guests INTEGER,
      status TEXT NOT NULL DEFAULT 'confirmed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      stay_range DATERANGE GENERATED ALWAYS AS (daterange(checkin, checkout, '[)')) STORED
    );
  `);

  // Database-level guarantee: two active (confirmed/blocked) bookings can never
  // have overlapping date ranges, even under concurrent requests.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'bookings_no_overlap'
      ) THEN
        ALTER TABLE bookings
        ADD CONSTRAINT bookings_no_overlap
        EXCLUDE USING gist (stay_range WITH &&)
        WHERE (status IN ('confirmed', 'blocked'));
      END IF;
    END $$;
  `);
}

module.exports = { pool, initDb };
