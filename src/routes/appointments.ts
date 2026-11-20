import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth.js';

const router = Router();
router.use(requireAuth);

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

router.get('/', (req, res) => {
  const date = String(req.query.date ?? todayIso());
  const status = String(req.query.status ?? '').trim();
  const doctorId = req.query.doctorId ? Number(req.query.doctorId) : null;

  let sql = `
    SELECT
      a.*,
      p.patient_code,
      p.full_name as patient_name,
      p.phone as patient_phone,
      p.prakriti as patient_prakriti,
      p.allergies as patient_allergies,
      u.full_name as doctor_name
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    LEFT JOIN users u ON u.id = a.doctor_id
    WHERE a.appointment_date = ?
  `;
  const params: Array<string | number> = [date];

  if (status) {
    sql += ' AND a.status = ?';
    params.push(status);
  }
  if (doctorId) {
    sql += ' AND a.doctor_id = ?';
    params.push(doctorId);
  }

  sql += ' ORDER BY a.token_number ASC, a.appointment_time ASC';
  const appointments = db.prepare(sql).all(...params);
  res.json({ appointments, date });
});

router.post('/', (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  const patientId = Number(body.patient_id);
  if (!patientId) {
    res.status(400).json({ error: 'Patient is required' });
    return;
  }

  const patientExists = db.prepare('SELECT id FROM patients WHERE id = ?').get(patientId);
  if (!patientExists) {
    res.status(404).json({ error: 'Selected patient does not exist' });
    return;
  }

  const appointmentDate = String(body.appointment_date || todayIso());
  const now = new Date();
  const defaultTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const appointmentTime = String(body.appointment_time || defaultTime);
  const visitType = ['Walk-in', 'Scheduled', 'Follow-up', 'Therapy'].includes(body.visit_type)
    ? body.visit_type
    : 'Walk-in';
  const doctorId = body.doctor_id ? Number(body.doctor_id) : null;

  const maxRow = db
    .prepare('SELECT COALESCE(MAX(token_number), 0) as max_token FROM appointments WHERE appointment_date = ?')
    .get(appointmentDate) as { max_token: number };
  const tokenNumber = (maxRow?.max_token ?? 0) + 1;

  const result = db
    .prepare(`
      INSERT INTO appointments (
        patient_id, doctor_id, appointment_date, appointment_time,
        token_number, visit_type, chief_complaint, status, notes, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)
    `)
    .run(
      patientId,
      doctorId,
      appointmentDate,
      appointmentTime,
      tokenNumber,
      visitType,
      String(body.chief_complaint ?? ''),
      String(body.notes ?? ''),
      req.user!.id
    );

  const appointment = db
    .prepare(`
      SELECT a.*, p.patient_code, p.full_name as patient_name, p.phone as patient_phone, u.full_name as doctor_name
      FROM appointments a
      JOIN patients p ON p.id = a.patient_id
      LEFT JOIN users u ON u.id = a.doctor_id
      WHERE a.id = ?
    `)
    .get(Number(result.lastInsertRowid));

  res.status(201).json({ appointment });
});

router.patch('/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status ?? '');
  const notes = req.body?.notes;

  if (!['waiting', 'in_consultation', 'completed', 'cancelled', 'no_show'].includes(status)) {
    res.status(400).json({ error: 'Invalid appointment status' });
    return;
  }

  const existing = db.prepare('SELECT id FROM appointments WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ error: 'Appointment not found' });
    return;
  }

  if (notes !== undefined) {
    db.prepare(`
      UPDATE appointments
      SET status = ?, notes = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(status, String(notes), id);
  } else {
    db.prepare(`
      UPDATE appointments
      SET status = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(status, id);
  }

  const appointment = db
    .prepare(`
      SELECT a.*, p.patient_code, p.full_name as patient_name, p.phone as patient_phone, u.full_name as doctor_name
      FROM appointments a
      JOIN patients p ON p.id = a.patient_id
      LEFT JOIN users u ON u.id = a.doctor_id
      WHERE a.id = ?
    `)
    .get(id);

  res.json({ appointment });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare('DELETE FROM appointments WHERE id = ?').run(id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Appointment not found' });
    return;
  }
  res.json({ message: 'Appointment removed' });
});

export default router;
