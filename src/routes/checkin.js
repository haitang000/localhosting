import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { verifyTurnstile } from '../captcha.js';
import { grantPoints } from '../points.js';
import { db, now, audit } from '../db.js';

export const router = Router();
router.use(requireAuth);

router.get('/status', (req, res) => {
  const today = now().slice(0, 10);
  res.json({
    checkedIn: req.user.last_checkin_date === today,
    lastCheckinDate: req.user.last_checkin_date,
  });
});

router.post('/', (req, res) => {
  const { turnstileToken } = req.body || {};

  const today = now().slice(0, 10);
  if (req.user.last_checkin_date === today) {
    return res.status(400).json({ error: '今天已经签到过了，明天再来吧' });
  }

  if (!verifyTurnstile(turnstileToken, req.ip)) {
    return res.status(400).json({ error: '验证未通过，请重新验证' });
  }

  const points = Math.floor(Math.random() * 21) + 10;

  grantPoints(req.user, points, 'checkin');
  db.prepare('UPDATE users SET last_checkin_date = ? WHERE id = ?').run(today, req.user.id);
  audit(req.user, 'checkin', null, `+${points}`);

  res.json({ points, total: req.user.points });
});
