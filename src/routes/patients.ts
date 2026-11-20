import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';

const router = Router();
router.use(requireAuth);

function generatePatientCode(): string {
  const year = new Date().getFullYear();
  const prefix = `SW-${year}-`;
  const last = db
    .prepare('SELECT patient_code FROM patients WHERE patient_code LIKE ? ORDER BY id DESC LIMIT 1')
    .get(`${prefix}%`) as { patient_code: string } | undefined;

  let nextNum = 1;
  if (last?.patient_code) {
    const tail = Number(last.patient_code.slice(prefix.length));
    if (!Number.isNaN(tail)) nextNum = tail + 1;
  }
  return `${prefix}${String(nextNum).padStart(4, '0')}`;
}

router.get('/', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q) {
    const like = `%${q}%`;
    const patients = db
      .prepare(`
        SELECT * FROM patients
        WHERE full_name LIKE ? OR phone LIKE ? OR patient_code LIKE ? OR nic_passport LIKE ?
        ORDER BY updated_at DESC, id DESC
        LIMIT 200
      `)
      .all(like, like, like, like);
    res.json({ patients });
    return;
  }

  const patients = db
    .prepare('SELECT * FROM patients ORDER BY updated_at DESC, id DESC LIMIT 200')
    .all();
  res.json({ patients });
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  if (!patient) {
    res.status(404).json({ error: 'Patient not found' });
    return;
  }

  const appointments = db
    .prepare(`
      SELECT a.*, u.full_name as doctor_name
      FROM appointments a
      LEFT JOIN users u ON u.id = a.doctor_id
      WHERE a.patient_id = ?
      ORDER BY a.appointment_date DESC, a.id DESC
      LIMIT 50
    `)
    .all(id);

  const invoices = db
    .prepare(`
      SELECT * FROM invoices
      WHERE patient_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 50
    `)
    .all(id);

  res.json({ patient, appointments, invoices });
});

router.post('/', (req, res) => {
  const body = req.body ?? {};
  const fullName = String(body.full_name ?? '').trim();
  const phone = String(body.phone ?? '').trim();
  const gender = String(body.gender ?? '').trim();

  if (!fullName || !phone || !['Male', 'Female', 'Other'].includes(gender)) {
    res.status(400).json({ error: 'Full name, phone number, and gender are required' });
    return;
  }

  const code = generatePatientCode();
  const ageVal = body.age !== undefined && body.age !== '' && body.age !== null ? Number(body.age) : null;

  const result = db
    .prepare(`
      INSERT INTO patients (
        patient_code, full_name, date_of_birth, age, gender, phone, nic_passport,
        email, address, emergency_contact_name, emergency_contact_phone,
        blood_group, prakriti, allergies, chronic_conditions, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      code,
      fullName,
      String(body.date_of_birth ?? ''),
      Number.isNaN(ageVal) ? null : ageVal,
      gender,
      phone,
      String(body.nic_passport ?? ''),
      String(body.email ?? ''),
      String(body.address ?? ''),
      String(body.emergency_contact_name ?? ''),
      String(body.emergency_contact_phone ?? ''),
      String(body.blood_group ?? ''),
      String(body.prakriti ?? 'Not Assessed'),
      String(body.allergies ?? ''),
      String(body.chronic_conditions ?? ''),
      String(body.notes ?? '')
    );

  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(Number(result.lastInsertRowid));
  res.status(201).json({ patient });
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM patients WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ error: 'Patient not found' });
    return;
  }

  const body = req.body ?? {};
  const fullName = String(body.full_name ?? '').trim();
  const phone = String(body.phone ?? '').trim();
  const gender = String(body.gender ?? '').trim();

  if (!fullName || !phone || !['Male', 'Female', 'Other'].includes(gender)) {
    res.status(400).json({ error: 'Full name, phone number, and gender are required' });
    return;
  }

  const ageVal = body.age !== undefined && body.age !== '' && body.age !== null ? Number(body.age) : null;

  db.prepare(`
    UPDATE patients SET
      full_name = ?, date_of_birth = ?, age = ?, gender = ?, phone = ?,
      nic_passport = ?, email = ?, address = ?, emergency_contact_name = ?,
      emergency_contact_phone = ?, blood_group = ?, prakriti = ?,
      allergies = ?, chronic_conditions = ?, notes = ?,
      updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(
    fullName,
    String(body.date_of_birth ?? ''),
    Number.isNaN(ageVal) ? null : ageVal,
    gender,
    phone,
    String(body.nic_passport ?? ''),
    String(body.email ?? ''),
    String(body.address ?? ''),
    String(body.emergency_contact_name ?? ''),
    String(body.emergency_contact_phone ?? ''),
    String(body.blood_group ?? ''),
    String(body.prakriti ?? 'Not Assessed'),
    String(body.allergies ?? ''),
    String(body.chronic_conditions ?? ''),
    String(body.notes ?? ''),
    id
  );

  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  res.json({ patient });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const invoiceCount = (db.prepare('SELECT COUNT(*) as count FROM invoices WHERE patient_id = ?').get(id) as { count: number }).count;
  if (invoiceCount > 0) {
    res.status(409).json({ error: 'Cannot delete patient with billing records. Keep for clinic audit history.' });
    return;
  }
  const result = db.prepare('DELETE FROM patients WHERE id = ?').run(id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Patient not found' });
    return;
  }
  res.json({ message: 'Patient deleted' });
});

export default router;
