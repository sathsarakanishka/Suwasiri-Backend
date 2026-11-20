import { Router } from 'express';
import { db, withTransaction } from '../db.js';
import { requireAuth, requireRole, type AuthedRequest } from '../auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const category = String(req.query.category ?? '').trim();
  const q = String(req.query.q ?? '').trim();
  const includeInactive = req.query.includeInactive === 'true';

  let sql = 'SELECT * FROM inventory_items WHERE 1=1';
  const params: Array<string | number> = [];

  if (!includeInactive) {
    sql += ' AND is_active = 1';
  }
  if (category && ['medicine', 'treatment', 'supplement'].includes(category)) {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (q) {
    const like = `%${q}%`;
    sql += ' AND (name LIKE ? OR sku LIKE ? OR supplier LIKE ?)';
    params.push(like, like, like);
  }

  sql += ' ORDER BY category ASC, name ASC';
  const items = db.prepare(sql).all(...params);
  res.json({ items });
});

router.get('/:id/logs', (req, res) => {
  const id = Number(req.params.id);
  const logs = db
    .prepare(`
      SELECT l.*, u.full_name as user_name
      FROM inventory_logs l
      LEFT JOIN users u ON u.id = l.created_by
      WHERE l.item_id = ?
      ORDER BY l.id DESC
      LIMIT 100
    `)
    .all(id);
  res.json({ logs });
});

router.post('/', requireRole('admin', 'doctor'), (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  const sku = String(body.sku ?? '').trim().toUpperCase();
  const name = String(body.name ?? '').trim();
  const category = String(body.category ?? '').trim();
  const unit = String(body.unit ?? 'unit').trim();

  if (!sku || !name || !['medicine', 'treatment', 'supplement'].includes(category)) {
    res.status(400).json({ error: 'SKU, name, and valid category (medicine, treatment, supplement) are required' });
    return;
  }

  const unitPrice = Number(body.unit_price ?? 0);
  const stockQuantity = Number(body.stock_quantity ?? 0);
  const reorderLevel = Number(body.reorder_level ?? 5);

  if (Number.isNaN(unitPrice) || unitPrice < 0 || Number.isNaN(stockQuantity) || stockQuantity < 0) {
    res.status(400).json({ error: 'Price and stock quantity must be non-negative numbers' });
    return;
  }

  try {
    const item = withTransaction(() => {
      const result = db
        .prepare(`
          INSERT INTO inventory_items (
            sku, name, category, unit, unit_price, stock_quantity,
            reorder_level, expiry_date, supplier, description
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          sku,
          name,
          category,
          unit,
          unitPrice,
          category === 'treatment' ? 999 : stockQuantity,
          category === 'treatment' ? 0 : reorderLevel,
          String(body.expiry_date ?? ''),
          String(body.supplier ?? ''),
          String(body.description ?? '')
        );

      const newId = Number(result.lastInsertRowid);
      if (category !== 'treatment' && stockQuantity > 0) {
        db.prepare(`
          INSERT INTO inventory_logs (item_id, change_amount, reason, notes, created_by)
          VALUES (?, ?, 'initial', 'Initial stock added', ?)
        `).run(newId, stockQuantity, req.user!.id);
      }

      return db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(newId);
    });

    res.status(201).json({ item });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('UNIQUE')) {
      res.status(409).json({ error: `SKU "${sku}" already exists` });
      return;
    }
    throw err;
  }
});

router.put('/:id', requireRole('admin', 'doctor'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id) as { id: number } | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Inventory item not found' });
    return;
  }

  const body = req.body ?? {};
  const name = String(body.name ?? '').trim();
  const category = String(body.category ?? '').trim();
  const unit = String(body.unit ?? 'unit').trim();
  const unitPrice = Number(body.unit_price ?? 0);
  const reorderLevel = Number(body.reorder_level ?? 0);

  if (!name || !['medicine', 'treatment', 'supplement'].includes(category) || Number.isNaN(unitPrice) || unitPrice < 0) {
    res.status(400).json({ error: 'Valid name, category, and non-negative unit price are required' });
    return;
  }

  db.prepare(`
    UPDATE inventory_items SET
      name = ?, category = ?, unit = ?, unit_price = ?,
      reorder_level = ?, expiry_date = ?, supplier = ?, description = ?,
      is_active = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(
    name,
    category,
    unit,
    unitPrice,
    Number.isNaN(reorderLevel) ? 0 : reorderLevel,
    String(body.expiry_date ?? ''),
    String(body.supplier ?? ''),
    String(body.description ?? ''),
    body.is_active === 0 ? 0 : 1,
    id
  );

  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
  res.json({ item });
});

router.post('/:id/adjust', requireRole('admin', 'doctor', 'receptionist'), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const amount = Number(req.body?.change_amount);
  const reason = String(req.body?.reason ?? 'adjustment');
  const notes = String(req.body?.notes ?? '');

  if (Number.isNaN(amount) || amount === 0) {
    res.status(400).json({ error: 'Non-zero adjustment amount is required' });
    return;
  }
  if (!['restock', 'dispense', 'adjustment'].includes(reason)) {
    res.status(400).json({ error: 'Invalid stock adjustment reason' });
    return;
  }

  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id) as
    | { id: number; category: string; stock_quantity: number }
    | undefined;
  if (!item) {
    res.status(404).json({ error: 'Inventory item not found' });
    return;
  }

  const nextQty = item.stock_quantity + amount;
  if (nextQty < 0) {
    res.status(400).json({ error: `Insufficient stock. Current stock is ${item.stock_quantity}.` });
    return;
  }

  const updated = withTransaction(() => {
    db.prepare(`
      UPDATE inventory_items
      SET stock_quantity = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(nextQty, id);

    db.prepare(`
      INSERT INTO inventory_logs (item_id, change_amount, reason, notes, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, amount, reason, notes, req.user!.id);

    return db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
  });

  res.json({ item: updated });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const usedInInvoices = (
    db.prepare('SELECT COUNT(*) as count FROM invoice_items WHERE inventory_item_id = ?').get(id) as { count: number }
  ).count;

  if (usedInInvoices > 0) {
    db.prepare("UPDATE inventory_items SET is_active = 0, updated_at = datetime('now', 'localtime') WHERE id = ?").run(id);
    res.json({ message: 'Item archived (used in past invoices)' });
    return;
  }

  const result = db.prepare('DELETE FROM inventory_items WHERE id = ?').run(id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  res.json({ message: 'Item deleted' });
});

export default router;
