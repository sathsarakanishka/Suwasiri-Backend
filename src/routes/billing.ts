import { Router } from 'express';
import { db, withTransaction } from '../db.js';
import { requireAuth, requireRole, type AuthedRequest } from '../auth.js';

const router = Router();
router.use(requireAuth);

function generateInvoiceNumber(): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const prefix = `INV-${stamp}-`;
  const last = db
    .prepare('SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY id DESC LIMIT 1')
    .get(`${prefix}%`) as { invoice_number: string } | undefined;

  let seq = 1;
  if (last?.invoice_number) {
    const tail = Number(last.invoice_number.slice(prefix.length));
    if (!Number.isNaN(tail)) seq = tail + 1;
  }
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

router.get('/', (req, res) => {
  const status = String(req.query.status ?? '').trim();
  const q = String(req.query.q ?? '').trim();

  let sql = `
    SELECT i.*, p.patient_code, p.full_name as patient_name, p.phone as patient_phone, u.full_name as created_by_name
    FROM invoices i
    JOIN patients p ON p.id = i.patient_id
    LEFT JOIN users u ON u.id = i.created_by
    WHERE 1=1
  `;
  const params: Array<string | number> = [];

  if (status && ['paid', 'partial', 'pending', 'void'].includes(status)) {
    sql += ' AND i.payment_status = ?';
    params.push(status);
  }
  if (q) {
    const like = `%${q}%`;
    sql += ' AND (i.invoice_number LIKE ? OR p.full_name LIKE ? OR p.patient_code LIKE ?)';
    params.push(like, like, like);
  }

  sql += ' ORDER BY i.id DESC LIMIT 200';
  const invoices = db.prepare(sql).all(...params);
  res.json({ invoices });
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const invoice = db
    .prepare(`
      SELECT i.*, p.patient_code, p.full_name as patient_name, p.phone as patient_phone,
             p.address as patient_address, p.prakriti as patient_prakriti,
             u.full_name as created_by_name
      FROM invoices i
      JOIN patients p ON p.id = i.patient_id
      LEFT JOIN users u ON u.id = i.created_by
      WHERE i.id = ?
    `)
    .get(id);

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC').all(id);
  const settingsRows = db.prepare("SELECT key, value FROM clinic_settings WHERE key != 'auth_secret'").all() as Array<{
    key: string;
    value: string;
  }>;
  const clinic = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));

  res.json({ invoice, items, clinic });
});

interface InvoiceLineInput {
  inventory_item_id?: number | null;
  description: string;
  category?: string;
  quantity: number;
  unit_price: number;
}

router.post('/', (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  const patientId = Number(body.patient_id);
  if (!patientId) {
    res.status(400).json({ error: 'Patient is required' });
    return;
  }

  const patient = db.prepare('SELECT id FROM patients WHERE id = ?').get(patientId);
  if (!patient) {
    res.status(404).json({ error: 'Patient not found' });
    return;
  }

  const consultationFee = Math.max(0, Number(body.consultation_fee ?? 0) || 0);
  const discount = Math.max(0, Number(body.discount ?? 0) || 0);
  const paymentMethod = ['cash', 'card', 'bank_transfer'].includes(body.payment_method)
    ? body.payment_method
    : 'cash';
  const rawItems: InvoiceLineInput[] = Array.isArray(body.items) ? body.items : [];

  const sanitizedItems = rawItems
    .map((item) => ({
      inventory_item_id: item.inventory_item_id ? Number(item.inventory_item_id) : null,
      description: String(item.description ?? '').trim(),
      category: String(item.category ?? 'medicine'),
      quantity: Math.max(0.01, Number(item.quantity ?? 1) || 1),
      unit_price: Math.max(0, Number(item.unit_price ?? 0) || 0),
    }))
    .filter((item) => item.description.length > 0);

  const itemsSubtotal = sanitizedItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
  const subtotal = consultationFee + itemsSubtotal;
  const totalAmount = Math.max(0, subtotal - discount);
  const paidAmount = Math.min(totalAmount, Math.max(0, Number(body.paid_amount ?? totalAmount) || 0));

  let paymentStatus: 'paid' | 'partial' | 'pending' = 'paid';
  if (paidAmount === 0 && totalAmount > 0) paymentStatus = 'pending';
  else if (paidAmount < totalAmount) paymentStatus = 'partial';

  try {
    const invoice = withTransaction(() => {
      const invoiceNumber = generateInvoiceNumber();
      const invRes = db
        .prepare(`
          INSERT INTO invoices (
            invoice_number, patient_id, appointment_id, consultation_fee,
            subtotal, discount, total_amount, paid_amount,
            payment_method, payment_status, notes, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          invoiceNumber,
          patientId,
          body.appointment_id ? Number(body.appointment_id) : null,
          consultationFee,
          subtotal,
          discount,
          totalAmount,
          paidAmount,
          paymentMethod,
          paymentStatus,
          String(body.notes ?? ''),
          req.user!.id
        );

      const invoiceId = Number(invRes.lastInsertRowid);

      for (const line of sanitizedItems) {
        const lineTotal = line.quantity * line.unit_price;
        let finalCategory = line.category;

        if (line.inventory_item_id) {
          const invItem = db
            .prepare('SELECT id, name, category, stock_quantity FROM inventory_items WHERE id = ?')
            .get(line.inventory_item_id) as
            | { id: number; name: string; category: string; stock_quantity: number }
            | undefined;

          if (!invItem) {
            throw new Error(`Inventory item #${line.inventory_item_id} not found`);
          }
          finalCategory = invItem.category;

          if (invItem.category !== 'treatment') {
            if (invItem.stock_quantity < line.quantity) {
              throw new Error(`Insufficient stock for "${invItem.name}" (available: ${invItem.stock_quantity})`);
            }
            db.prepare(`
              UPDATE inventory_items
              SET stock_quantity = stock_quantity - ?, updated_at = datetime('now', 'localtime')
              WHERE id = ?
            `).run(line.quantity, invItem.id);

            db.prepare(`
              INSERT INTO inventory_logs (item_id, change_amount, reason, reference_id, notes, created_by)
              VALUES (?, ?, 'dispense', ?, ?, ?)
            `).run(invItem.id, -line.quantity, invoiceNumber, `Billed on ${invoiceNumber}`, req.user!.id);
          }
        }

        db.prepare(`
          INSERT INTO invoice_items (invoice_id, inventory_item_id, description, category, quantity, unit_price, line_total)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(invoiceId, line.inventory_item_id, line.description, finalCategory, line.quantity, line.unit_price, lineTotal);
      }

      if (body.appointment_id && body.complete_appointment !== false) {
        db.prepare(`
          UPDATE appointments
          SET status = 'completed', updated_at = datetime('now', 'localtime')
          WHERE id = ? AND status IN ('waiting', 'in_consultation')
        `).run(Number(body.appointment_id));
      }

      return db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    });

    res.status(201).json({ invoice });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create invoice' });
  }
});

router.patch('/:id/payment', requireRole('admin', 'receptionist', 'doctor'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as
    | { id: number; total_amount: number; paid_amount: number; payment_status: string }
    | undefined;

  if (!existing) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  if (req.body?.void === true) {
    if (existing.payment_status === 'void') {
      res.status(400).json({ error: 'Invoice is already voided' });
      return;
    }
    db.prepare(`
      UPDATE invoices SET payment_status = 'void', updated_at = datetime('now', 'localtime') WHERE id = ?
    `).run(id);
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    res.json({ invoice });
    return;
  }

  const additionalPayment = Number(req.body?.amount ?? 0);
  const method = ['cash', 'card', 'bank_transfer'].includes(req.body?.payment_method)
    ? req.body.payment_method
    : 'cash';

  if (Number.isNaN(additionalPayment) || additionalPayment <= 0) {
    res.status(400).json({ error: 'Payment amount must be greater than zero' });
    return;
  }

  const nextPaid = Math.min(existing.total_amount, existing.paid_amount + additionalPayment);
  const nextStatus = nextPaid >= existing.total_amount ? 'paid' : 'partial';

  db.prepare(`
    UPDATE invoices
    SET paid_amount = ?, payment_status = ?, payment_method = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(nextPaid, nextStatus, method, id);

  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  res.json({ invoice });
});

export default router;
