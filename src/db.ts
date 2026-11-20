import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DATA_DIR = process.env.SUWASIRI_DATA_DIR
  ? path.resolve(process.env.SUWASIRI_DATA_DIR)
  : path.resolve(__dirname, '..', '..', 'data');

export const DB_PATH = process.env.SUWASIRI_DB_PATH
  ? path.resolve(process.env.SUWASIRI_DB_PATH)
  : path.join(DATA_DIR, 'suwasiri.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

export function withTransaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback errors if transaction wasn't active
    }
    throw err;
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const storedBuf = Buffer.from(hash, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

export function initDatabase(): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS clinic_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'doctor', 'receptionist')),
      password_hash TEXT NOT NULL,
      specialty TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_code TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      date_of_birth TEXT DEFAULT '',
      age INTEGER,
      gender TEXT NOT NULL CHECK (gender IN ('Male', 'Female', 'Other')),
      phone TEXT NOT NULL,
      nic_passport TEXT DEFAULT '',
      email TEXT DEFAULT '',
      address TEXT DEFAULT '',
      emergency_contact_name TEXT DEFAULT '',
      emergency_contact_phone TEXT DEFAULT '',
      blood_group TEXT DEFAULT '',
      prakriti TEXT DEFAULT 'Not Assessed',
      allergies TEXT DEFAULT '',
      chronic_conditions TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      doctor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      appointment_date TEXT NOT NULL,
      appointment_time TEXT NOT NULL,
      token_number INTEGER NOT NULL,
      visit_type TEXT NOT NULL CHECK (visit_type IN ('Walk-in', 'Scheduled', 'Follow-up', 'Therapy')),
      chief_complaint TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'in_consultation', 'completed', 'cancelled', 'no_show')),
      notes TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('medicine', 'treatment', 'supplement')),
      unit TEXT NOT NULL,
      unit_price REAL NOT NULL DEFAULT 0,
      stock_quantity REAL NOT NULL DEFAULT 0,
      reorder_level REAL NOT NULL DEFAULT 5,
      expiry_date TEXT DEFAULT '',
      supplier TEXT DEFAULT '',
      description TEXT DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS inventory_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      change_amount REAL NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('restock', 'dispense', 'adjustment', 'initial')),
      reference_id TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT NOT NULL UNIQUE,
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
      appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
      consultation_fee REAL NOT NULL DEFAULT 0,
      subtotal REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      paid_amount REAL NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card', 'bank_transfer')),
      payment_status TEXT NOT NULL DEFAULT 'paid' CHECK (payment_status IN ('paid', 'partial', 'pending', 'void')),
      notes TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'medicine',
      quantity REAL NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(full_name);
    CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone);
    CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(appointment_date);
    CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(created_at);
  `);

  seedDefaults();
}

function seedDefaults(): void {
  const settingsCount = (db.prepare('SELECT COUNT(*) as count FROM clinic_settings').get() as { count: number }).count;
  if (settingsCount === 0) {
    const insertSetting = db.prepare('INSERT INTO clinic_settings (key, value) VALUES (?, ?)');
    const defaults: Array<[string, string]> = [
      ['clinic_name', 'Suwasiri Ayurvedic Wellness Center'],
      ['tagline', 'Natural Healing for a Healthier Tomorrow'],
      ['phone', '076 667 7779'],
      ['address', 'Colombo, Sri Lanka'],
      ['currency', 'Rs.'],
      ['consultation_fee', '1500'],
    ];
    for (const [k, v] of defaults) {
      insertSetting.run(k, v);
    }
  }

  const usersCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  if (usersCount === 0) {
    const insertUser = db.prepare(
      'INSERT INTO users (username, full_name, role, password_hash, specialty, phone) VALUES (?, ?, ?, ?, ?, ?)'
    );
    insertUser.run('admin', 'Clinic Administrator', 'admin', hashPassword('admin123'), 'Clinic Management', '076 667 7779');
    insertUser.run('doctor1', 'Dr. Physician 1', 'doctor', hashPassword('doctor123'), 'Ayurvedic General & Panchakarma', '');
    insertUser.run('doctor2', 'Dr. Physician 2', 'doctor', hashPassword('doctor123'), 'Ayurvedic Physician', '');
    insertUser.run('doctor3', 'Dr. Physician 3', 'doctor', hashPassword('doctor123'), 'Ayurvedic Physician', '');
    insertUser.run('doctor4', 'Dr. Physician 4', 'doctor', hashPassword('doctor123'), 'Ayurvedic Physician', '');
  }

  const invCount = (db.prepare('SELECT COUNT(*) as count FROM inventory_items').get() as { count: number }).count;
  if (invCount === 0) {
    const insertItem = db.prepare(`
      INSERT INTO inventory_items (sku, name, category, unit, unit_price, stock_quantity, reorder_level, expiry_date, supplier, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertLog = db.prepare(`
      INSERT INTO inventory_logs (item_id, change_amount, reason, notes)
      VALUES (?, ?, 'initial', 'Starter Ayurvedic clinic catalog')
    `);

    const starterItems = [
      ['TRT-001', 'Abhyanga Full Body Herbal Oil Massage', 'treatment', 'session', 4500, 999, 0, '', 'In-House Therapy', '60-minute warm medicated oil therapeutic massage'],
      ['TRT-002', 'Shirodhara Stress Relief Therapy', 'treatment', 'session', 5500, 999, 0, '', 'In-House Therapy', 'Continuous warm herbal oil stream therapy for forehead'],
      ['TRT-003', 'Swedana Herbal Steam Bath', 'treatment', 'session', 2500, 999, 0, '', 'In-House Therapy', 'Detoxifying herbal steam chamber therapy'],
      ['TRT-004', 'Nasya Nasal Cleansing Therapy', 'treatment', 'session', 2200, 999, 0, '', 'In-House Therapy', 'Sinus & head purification Ayurvedic treatment'],
      ['MED-101', 'Ashwagandha Churna (100g)', 'medicine', 'pack', 950, 25, 5, '2027-08-30', 'Lanka Ayurveda Herbs', 'Adaptogenic root powder for vitality and stress balance'],
      ['MED-102', 'Triphala Tablets (60 Tabs)', 'medicine', 'bottle', 850, 30, 8, '2027-10-15', 'Lanka Ayurveda Herbs', 'Gentle digestive & detoxification support'],
      ['MED-103', 'Dashamoolarishta (450ml)', 'medicine', 'bottle', 1450, 18, 5, '2027-06-30', 'Siddhalepa Wholesale', 'Classical herbal decoction for recovery & joint comfort'],
      ['MED-104', 'Pinda Thailaya (200ml)', 'medicine', 'bottle', 1200, 20, 6, '2027-12-01', 'Siddhalepa Wholesale', 'Cooling medicated oil for joint & skin inflammation'],
      ['SUP-201', 'Brahmi Memory & Focus Syrup (200ml)', 'supplement', 'bottle', 1100, 15, 5, '2027-09-20', 'Kandy Herbal Care', 'Cognitive and nervous system wellness tonic'],
    ];

    for (const item of starterItems) {
      const result = insertItem.run(...item);
      if (item[2] !== 'treatment') {
        insertLog.run(Number(result.lastInsertRowid), item[5]);
      }
    }
  }
}
