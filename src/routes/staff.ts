import { Router } from 'express';
import { db, hashPassword } from '../db.js';
import { requireAuth, requireRole, type AuthedRequest } from '../auth.js';

const router = Router();
router.use(requireAuth);

router.get('/settings', (_req, res) => {
  const rows = db.prepare("SELECT key, value FROM clinic_settings WHERE key != 'auth_secret'").all() as Array<{
    key: string;
    value: string;
  }>;
  res.json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
});

router.put('/settings', requireRole('admin'), (req, res) => {
  const allowed = ['clinic_name', 'tagline', 'phone', 'address', 'currency', 'consultation_fee'];
  const upsert = db.prepare('INSERT OR REPLACE INTO clinic_settings (key, value) VALUES (?, ?)');
  for (const key of allowed) {
    if (req.body?.[key] !== undefined) {
      upsert.run(key, String(req.body[key]).trim());
    }
  }
  const rows = db.prepare("SELECT key, value FROM clinic_settings WHERE key != 'auth_secret'").all() as Array<{
    key: string;
    value: string;
  }>;
  res.json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
});

router.get('/staff', requireRole('admin'), (_req, res) => {
  const staff = db
    .prepare('SELECT id, username, full_name, role, specialty, phone, is_active, created_at FROM users ORDER BY id ASC')
    .all();
  res.json({ staff });
});

router.post('/staff', requireRole('admin'), (req, res) => {
  const body = req.body ?? {};
  const username = String(body.username ?? '').trim().toLowerCase();
  const fullName = String(body.full_name ?? '').trim();
  const role = String(body.role ?? '').trim();
  const password = String(body.password ?? '');

  if (!username || !fullName || !['admin', 'doctor', 'receptionist'].includes(role) || password.length < 6) {
    res.status(400).json({ error: 'Username, full name, valid role, and password (min 6 chars) are required' });
    return;
  }

  try {
    const result = db
      .prepare(`
        INSERT INTO users (username, full_name, role, password_hash, specialty, phone)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        username,
        fullName,
        role,
        hashPassword(password),
        String(body.specialty ?? ''),
        String(body.phone ?? '')
      );

    const member = db
      .prepare('SELECT id, username, full_name, role, specialty, phone, is_active, created_at FROM users WHERE id = ?')
      .get(Number(result.lastInsertRowid));
    res.status(201).json({ member });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('UNIQUE')) {
      res.status(409).json({ error: `Username "${username}" is already taken` });
      return;
    }
    throw err;
  }
});

router.put('/staff/:id', requireRole('admin'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const fullName = String(body.full_name ?? '').trim();
  const role = String(body.role ?? '').trim();
  const isActive = body.is_active === 0 || body.is_active === false ? 0 : 1;

  if (!fullName || !['admin', 'doctor', 'receptionist'].includes(role)) {
    res.status(400).json({ error: 'Valid full name and role are required' });
    return;
  }

  if (id === req.user!.id && isActive === 0) {
    res.status(400).json({ error: 'You cannot deactivate your own active admin account' });
    return;
  }

  db.prepare(`
    UPDATE users SET full_name = ?, role = ?, specialty = ?, phone = ?, is_active = ? WHERE id = ?
  `).run(fullName, role, String(body.specialty ?? ''), String(body.phone ?? ''), isActive, id);

  const member = db
    .prepare('SELECT id, username, full_name, role, specialty, phone, is_active, created_at FROM users WHERE id = ?')
    .get(id);
  if (!member) {
    res.status(404).json({ error: 'Staff member not found' });
    return;
  }
  res.json({ member });
});

router.post('/staff/:id/reset-password', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const newPassword = String(req.body?.password ?? '');
  if (newPassword.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }
  const result = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Staff member not found' });
    return;
  }
  res.json({ message: 'Password reset successfully' });
});

export default router;
