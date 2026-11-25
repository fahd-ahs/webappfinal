require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { GoogleGenAI, Type } = require('@google/genai');
const {
  PODCAST_EPISODE_IDS,
  ensureEpisodeAudio,
  getCachedAudioInfo,
  warmupPodcastCache,
} = require('./lib/studycastPodcast');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || crypto.createHash('sha256').update('schoolexpo-default-secret').digest('hex');

app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// ============================================================
// PERSISTENT DATABASE (JSON snapshot backed in /data/store.json)
// ============================================================
const DB_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'store.json');

const store = {
  users: [],
  xp_profiles: [],
  xp_events: [],
  subjects: [],
  chapters: [],
  topics: [],
  assignments: [],
  submissions: [],
  attendance: [],
  results: [],
  dpp_sets: [],
  questions: [],
  dpp_attempts: [],
  todos: [],
  timetable: [],
  announcements: [],
  notifications: [],
  studycast: [],
  studycast_progress: [],
  invoices: [],
  payment_transactions: [],
  chat_rooms: [],
  chat_messages: [],
  ai_chats: [],
};

const SCHOOL_IDENTITY = {
  name: 'The Oxford School',
  tagline: 'Excellence in Senior Secondary Education',
  department: 'Academic Fee & Billing Office',
  address: '14 Innovation Campus, Bengaluru 560001',
  email: 'billing@theoxfordschool.edu',
  phone: '+91 80 4120 2026',
  website: 'www.theoxfordschool.edu',
  gstin: '29AABCS2026E1Z5',
  academic_year: '2026-27',
};

function roundCurrency(value) {
  const num = Number(value) || 0;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

function toDateOnly(dateInput) {
  if (!dateInput) return new Date().toISOString().split('T')[0];
  const str = String(dateInput);
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? new Date().toISOString().split('T')[0] : d.toISOString().split('T')[0];
}

function computeInvoiceStatus(inv, todayStr = new Date().toISOString().split('T')[0]) {
  const total = roundCurrency(inv.total_amount || 0);
  const paid = roundCurrency(Math.min(total, Math.max(0, inv.amount_paid || 0)));
  const balance = roundCurrency(Math.max(0, total - paid));
  if (balance <= 0) return 'PAID';
  if (paid > 0) return 'PARTIAL';
  if (inv.due_date && inv.due_date < todayStr) return 'OVERDUE';
  return 'UNPAID';
}

function canAccessStudentBilling(user, studentId) {
  if (!user || !studentId) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'student') return user.id === studentId;
  if (user.role === 'parent') {
    const linked = Array.isArray(user.linked_student_ids)
      ? user.linked_student_ids
      : Array.isArray(user.child_ids)
        ? user.child_ids
        : [];
    return linked.includes(studentId);
  }
  return false;
}

function getBillingScopedInvoices(user) {
  if (!user) return { allowed: false, invoices: [] };
  if (user.role === 'admin') {
    return { allowed: true, invoices: [...store.invoices] };
  }
  if (user.role === 'student') {
    return {
      allowed: true,
      invoices: store.invoices.filter((inv) => inv.student_id === user.id),
    };
  }
  if (user.role === 'parent') {
    const linked = Array.isArray(user.linked_student_ids)
      ? user.linked_student_ids
      : Array.isArray(user.child_ids)
        ? user.child_ids
        : [];
    if (linked.length === 0) return { allowed: false, invoices: [] };
    return {
      allowed: true,
      invoices: store.invoices.filter((inv) => linked.includes(inv.student_id)),
    };
  }
  return { allowed: false, invoices: [] };
}

// ============================================================
// XP SYSTEM
// ============================================================
const XP_REWARDS = {
  assignment_submitted: 50,
  assignment_graded_above_80: 30,
  dpp_completed: 30,
  dpp_perfect_score: 50,
  todo_completed: 5,
  login_streak_7: 100,
  login_streak_30: 500,
  first_submission: 25,
};

const LEVELS = [
  { level: 1, min_xp: 0, title: 'Newcomer' },
  { level: 2, min_xp: 200, title: 'Learner' },
  { level: 3, min_xp: 500, title: 'Scholar' },
  { level: 4, min_xp: 1000, title: 'Expert' },
  { level: 5, min_xp: 2000, title: 'Master' },
  { level: 6, min_xp: 3500, title: 'Champion' },
  { level: 7, min_xp: 5000, title: 'Legend' },
];

function getLevel(xp) {
  let current = LEVELS[0];
  for (const lvl of LEVELS) {
    if (xp >= lvl.min_xp) {
      current = lvl;
    }
  }
  return current;
}

function awardXp(userId, amount, reason) {
  let profile = store.xp_profiles.find((p) => p.user_id === userId);
  if (!profile) {
    profile = {
      user_id: userId,
      total_xp: 0,
      level: 1,
      streak: 0,
      badges: [],
      created_at: new Date().toISOString(),
    };
    store.xp_profiles.push(profile);
  }
  const newXp = (profile.total_xp || 0) + amount;
  const newLevel = getLevel(newXp);
  profile.total_xp = newXp;
  profile.level = newLevel.level;
  profile.last_activity = new Date().toISOString();

  store.xp_events.push({
    user_id: userId,
    amount,
    reason,
    created_at: new Date().toISOString(),
  });

  saveStore();
  return { amount, reason, new_total: newXp, new_level: newLevel };
}

function saveStore() {
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    const tmpFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(store), 'utf8');
    fs.renameSync(tmpFile, DB_FILE);
  } catch (err) {
    console.error('Failed to persist store:', err.message);
  }
}

function normalizeStore() {
  let storeMutated = false;

  // Idempotent migration of demo student identities & Class 12 A
  const DEMO_STUDENT_NAME_BY_EMAIL = {
    'aarav@schoolexpo.com': 'Mohamed Fahd',
    'ananya@schoolexpo.com': 'Amina Sidheeg',
    'arjun@schoolexpo.com': 'Nazreena Dilip',
    'diya@schoolexpo.com': 'Fasna Sherin',
    'ishaan@schoolexpo.com': 'Swathi Bijukumar',
    'kavya@schoolexpo.com': 'Hisham Muhammad',
    'rohan@schoolexpo.com': 'Muhammed Saad',
    'saanvi@schoolexpo.com': 'Muhammed Abdullah',
    'vihaan@schoolexpo.com': 'Dev Sreekumar',
  };

  // Remove the extra 10th seeded placeholder student (zara@schoolexpo.com) so leaderboard has exactly Mohamed Fahd + the 8 classmates
  const zaraUser = store.users.find((u) => u.email === 'zara@schoolexpo.com' && u.role === 'student');
  if (zaraUser) {
    const zaraId = zaraUser.id;
    store.users = store.users.filter((u) => u.id !== zaraId);
    store.xp_profiles = store.xp_profiles.filter((p) => p.user_id !== zaraId);
    store.xp_events = store.xp_events.filter((e) => e.user_id !== zaraId);
    store.attendance = store.attendance.filter((a) => a.student_id !== zaraId);
    store.results = store.results.filter((r) => r.student_id !== zaraId);
    store.invoices = store.invoices.filter((inv) => inv.student_id !== zaraId);
    store.payment_transactions = store.payment_transactions.filter((t) => t.student_id !== zaraId);
    store.submissions = store.submissions.filter((s) => s.student_id !== zaraId);
    store.notifications = store.notifications.filter((n) => n.user_id !== zaraId);
    store.chat_messages = store.chat_messages.filter((m) => m.sender_id !== zaraId);
    storeMutated = true;
  }

  for (const u of store.users) {
    if (u.role === 'student' && DEMO_STUDENT_NAME_BY_EMAIL[u.email]) {
      const targetName = DEMO_STUDENT_NAME_BY_EMAIL[u.email];
      if (u.name !== targetName) {
        u.name = targetName;
        storeMutated = true;
      }
    }
    if (u.class_name === '11-A') {
      u.class_name = '12 A';
      storeMutated = true;
    }
    if (u.role === 'teacher') {
      if (!Array.isArray(u.assigned_classes) || u.assigned_classes.length === 0) {
        u.assigned_classes = u.class_name ? [u.class_name] : ['12 A'];
        storeMutated = true;
      } else if (u.assigned_classes.includes('11-A')) {
        u.assigned_classes = [...new Set(u.assigned_classes.map((c) => (c === '11-A' ? '12 A' : c)))];
        storeMutated = true;
      }
    }
  }

  const userById = new Map(store.users.map((u) => [u.id, u]));

  for (const subj of store.subjects) {
    if (subj.class_name === '11-A') {
      subj.class_name = '12 A';
      storeMutated = true;
    }
  }
  for (const slot of store.timetable) {
    if (slot.class_name === '11-A') {
      slot.class_name = '12 A';
      storeMutated = true;
    }
  }
  for (const dpp of store.dpp_sets) {
    if (dpp.class_name === '11-A') {
      dpp.class_name = '12 A';
      storeMutated = true;
    }
  }
  for (const a of store.assignments) {
    if (!a.status) {
      a.status = 'published';
      storeMutated = true;
    }
    if (!a.published_at && a.status === 'published') {
      a.published_at = a.created_at;
      storeMutated = true;
    }
    if (!a.teacher_name) {
      const creator = userById.get(a.created_by);
      a.teacher_name = creator ? creator.name : 'Class Teacher';
      storeMutated = true;
    }
    if (a.class_name === '11-A') {
      a.class_name = '12 A';
      storeMutated = true;
    }
  }
  for (const s of store.submissions) {
    const stu = userById.get(s.student_id);
    if (stu && s.student_name !== stu.name) {
      s.student_name = stu.name;
      storeMutated = true;
    }
    if (!Array.isArray(s.history) || s.history.length === 0) {
      s.history = [
        {
          id: crypto.randomUUID(),
          action: 'submitted',
          actor_name: s.student_name || 'Student',
          actor_role: 'student',
          timestamp: s.submitted_at || new Date().toISOString(),
          note: s.attachment?.file_name
            ? `Submitted response with file ${s.attachment.file_name}`
            : 'Submitted written response',
        },
      ];
      if (s.status === 'graded' && s.graded_at) {
        const asg = store.assignments.find((a) => a.id === s.assignment_id);
        s.history.push({
          id: crypto.randomUUID(),
          action: 'graded',
          actor_name: s.graded_by_name || asg?.teacher_name || 'Teacher',
          actor_role: 'teacher',
          timestamp: s.graded_at,
          marks_obtained: s.marks_obtained,
          max_marks: asg?.max_marks || null,
          note: s.feedback || 'Grade published',
        });
      }
      storeMutated = true;
    } else if (stu) {
      for (const h of s.history) {
        if (h.actor_role === 'student' && h.actor_name !== stu.name) {
          h.actor_name = stu.name;
          storeMutated = true;
        }
      }
    }
  }
  for (const m of store.chat_messages) {
    const sender = userById.get(m.sender_id);
    if (sender && m.sender_name !== sender.name) {
      m.sender_name = sender.name;
      storeMutated = true;
    }
  }
  const todayStr = new Date().toISOString().split('T')[0];
  const dayShift = (offsetDays) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().split('T')[0];
  };

  const legacyFeePlans = [
    {
      category: 'Tuition Fee - Term 1',
      line_items: [
        { label: 'Academic Tuition (Term 1)', amount: 10500, gst_amount: 1890 },
        { label: 'Digital Campus & Library Access', amount: 2000, gst_amount: 360 },
      ],
      issueOffset: -30,
      dueOffset: -18,
    },
    {
      category: 'Campus Transport - Q1',
      line_items: [
        { label: 'School Bus Route Pass (Q1)', amount: 3000, gst_amount: 150 },
        { label: 'GPS Safety & Tracking Service', amount: 500, gst_amount: 25 },
      ],
      issueOffset: -25,
      dueOffset: -12,
    },
    {
      category: 'Tuition Fee - Term 2',
      line_items: [
        { label: 'Academic Tuition (Term 2)', amount: 10500, gst_amount: 1890 },
        { label: 'Continuous Assessment & Lab Support', amount: 2000, gst_amount: 360 },
      ],
      issueOffset: -14,
      dueOffset: 12,
    },
    {
      category: 'Books & Academic Kit',
      line_items: [
        { label: 'Textbooks & Reference Modules', amount: 1400, gst_amount: 168 },
        { label: 'Printed Practice Workbooks', amount: 600, gst_amount: 72 },
      ],
      issueOffset: -20,
      dueOffset: -5,
    },
    {
      category: 'Science & CS Lab Fee',
      line_items: [
        { label: 'Physics & Chemistry Lab Consumables', amount: 900, gst_amount: 162 },
        { label: 'Computer Science Cloud Sandbox', amount: 600, gst_amount: 108 },
      ],
      issueOffset: -6,
      dueOffset: 20,
    },
  ];

  for (let idx = 0; idx < store.invoices.length; idx++) {
    const inv = store.invoices[idx];
    const stu = userById.get(inv.student_id);
    if (stu && inv.student_name !== stu.name) {
      inv.student_name = stu.name;
      storeMutated = true;
    }
    if (inv.class_name === '11-A') {
      inv.class_name = '12 A';
      storeMutated = true;
    }
    if (!inv.billing_v2) {
      const slotMatch = String(inv.id || '').match(/^inv-\d+-(\d+)$/);
      const slotIdx = slotMatch ? Math.max(0, Math.min(4, Number(slotMatch[1]) - 1)) : idx % 5;
      const plan = legacyFeePlans[slotIdx];
      if (typeof inv.invoice_number === 'string' && inv.invoice_number.startsWith('INV-2024-')) {
        inv.invoice_number = inv.invoice_number.replace('INV-2024-', 'INV-2026-');
      }
      inv.category = plan.category;
      inv.line_items = plan.line_items;
      inv.issue_date = dayShift(plan.issueOffset);
      if (inv.status === 'PAID') {
        inv.due_date = dayShift(Math.min(-8, plan.dueOffset));
      } else if (inv.status === 'OVERDUE') {
        inv.due_date = dayShift(-5);
      } else if (inv.status === 'PARTIAL') {
        inv.due_date = dayShift(12);
      } else {
        inv.due_date = dayShift(20);
      }
      inv.academic_year = SCHOOL_IDENTITY.academic_year;
      inv.billing_v2 = true;
      storeMutated = true;
    }

    if (!inv.issue_date) {
      inv.issue_date = toDateOnly(inv.created_at);
      storeMutated = true;
    }
    const total = roundCurrency(inv.total_amount || 0);
    const paid = roundCurrency(Math.min(total, Math.max(0, inv.amount_paid || 0)));
    const balance = roundCurrency(Math.max(0, total - paid));
    if (inv.balance_due !== balance) {
      inv.balance_due = balance;
      storeMutated = true;
    }
    const nextStatus = computeInvoiceStatus(inv, todayStr);
    if (inv.status !== nextStatus) {
      inv.status = nextStatus;
      storeMutated = true;
    }

    if (paid > 0) {
      const hasTxn = store.payment_transactions.some((t) => t.invoice_id === inv.id);
      if (!hasTxn) {
        const paidAt = inv.paid_at || inv.created_at || new Date().toISOString();
        const seq = String(store.payment_transactions.length + 1).padStart(4, '0');
        const dateToken = toDateOnly(paidAt).replace(/-/g, '');
        store.payment_transactions.push({
          id: `txn-seed-${inv.id}`,
          invoice_id: inv.id,
          invoice_number: inv.invoice_number,
          invoice_category: inv.category,
          student_id: inv.student_id,
          student_name: inv.student_name,
          class_name: inv.class_name || '12 A',
          roll_number: inv.roll_number || 'N/A',
          paid_by_user_id: inv.student_id,
          paid_by_name: inv.student_name,
          paid_by_role: 'student',
          amount: paid,
          balance_after: balance,
          invoice_status_after: nextStatus,
          payment_method: inv.status === 'PARTIAL' ? 'UPI' : 'NET_BANKING',
          method_detail:
            inv.status === 'PARTIAL'
              ? `${(inv.student_name || 'student').split(' ')[0].toLowerCase()}@demoupi`
              : 'Demo National Bank •••• 1024',
          status: 'SUCCESS',
          is_demo: true,
          mode: 'DEMO',
          demo_notice: 'Exhibition Demonstration — No real money charged',
          reference_number: `DEMO-TXN-${dateToken}-${seq}`,
          receipt_number: `RCPT-2026-${seq}`,
          idempotency_key: `seed-${inv.id}`,
          paid_at: paidAt,
          created_at: paidAt,
        });
        storeMutated = true;
      }
    }
  }

  for (const txn of store.payment_transactions) {
    const stu = userById.get(txn.student_id);
    if (stu) {
      if (txn.student_name !== stu.name) {
        txn.student_name = stu.name;
        storeMutated = true;
      }
      if (txn.paid_by_user_id === stu.id && txn.paid_by_name !== stu.name) {
        txn.paid_by_name = stu.name;
        storeMutated = true;
      }
      if (txn.id?.startsWith('txn-seed-') && txn.payment_method === 'UPI') {
        const expectedUpi = `${stu.name.split(' ')[0].toLowerCase()}@demoupi`;
        if (txn.method_detail !== expectedUpi) {
          txn.method_detail = expectedUpi;
          storeMutated = true;
        }
      }
    }
    if (txn.class_name === '11-A') {
      txn.class_name = '12 A';
      storeMutated = true;
    }
  }
  return storeMutated;
}

function loadStore() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      for (const key of Object.keys(store)) {
        if (Array.isArray(parsed[key])) {
          store[key] = parsed[key];
        }
      }
      const mutated = normalizeStore();
      if (mutated) {
        saveStore();
      }
      return true;
    }
  } catch (err) {
    console.error('Failed to load persisted store, re-seeding:', err.message);
  }
  return false;
}

// ============================================================
// AUTH HELPERS
// ============================================================
function createAccessToken(userId, email, role) {
  return jwt.sign({ sub: userId, email, role, type: 'access' }, JWT_SECRET, { expiresIn: '60m' });
}

function createRefreshToken(userId) {
  return jwt.sign({ sub: userId, type: 'refresh' }, JWT_SECRET, { expiresIn: '7d' });
}

function sanitizeUser(user) {
  const { password_hash, ...rest } = user;
  return { ...rest };
}

function requireAuth(req, res, next) {
  let token = req.cookies?.access_token;
  if (!token) {
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }
  }
  if (!token) {
    return res.status(401).json({ detail: 'Not authenticated' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== 'access') {
      return res.status(401).json({ detail: 'Invalid token type' });
    }
    const user = store.users.find((u) => u.id === payload.sub);
    if (!user) {
      return res.status(401).json({ detail: 'User not found' });
    }
    req.user = sanitizeUser(user);
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ detail: 'Token expired' });
    }
    return res.status(401).json({ detail: 'Invalid token' });
  }
}

function requireMediaAuth(req, res, next) {
  let token = req.cookies?.access_token;
  if (!token) {
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }
  }
  if (!token && typeof req.query?.token === 'string' && req.query.token.trim()) {
    token = req.query.token.trim();
  }
  if (!token) {
    return res.status(401).json({ detail: 'Not authenticated' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== 'access') {
      return res.status(401).json({ detail: 'Invalid token type' });
    }
    const user = store.users.find((u) => u.id === payload.sub);
    if (!user) {
      return res.status(401).json({ detail: 'User not found' });
    }
    req.user = sanitizeUser(user);
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ detail: 'Token expired' });
    }
    return res.status(401).json({ detail: 'Invalid token' });
  }
}

// ============================================================
// SEED DATA
// ============================================================
function seedData() {
  if (store.users.length > 0) return;

  const now = new Date();
  const daysAgo = (d) => new Date(now.getTime() - d * 86400000).toISOString();
  const daysFromNow = (d) => new Date(now.getTime() + d * 86400000).toISOString();
  const hoursAgo = (h) => new Date(now.getTime() - h * 3600000).toISOString();

  // Subjects
  store.subjects = [
    { id: 'sub-math', name: 'Mathematics', code: 'MATH-11', color: '#6366f1', icon: 'calculator', class_name: '12 A' },
    { id: 'sub-physics', name: 'Physics', code: 'PHY-11', color: '#22d3ee', icon: 'atom', class_name: '12 A' },
    { id: 'sub-chemistry', name: 'Chemistry', code: 'CHEM-11', color: '#10b981', icon: 'flask-conical', class_name: '12 A' },
    { id: 'sub-english', name: 'English', code: 'ENG-11', color: '#f59e0b', icon: 'book-open', class_name: '12 A' },
    { id: 'sub-cs', name: 'Computer Science', code: 'CS-11', color: '#8b5cf6', icon: 'code', class_name: '12 A' },
  ];

  // Admin
  const adminId = crypto.randomUUID();
  store.users.push({
    id: adminId,
    name: 'Admin',
    email: 'admin@schoolexpo.com',
    password_hash: bcrypt.hashSync('admin123', 8),
    role: 'admin',
    class_name: 'ALL',
    created_at: now.toISOString(),
  });

  // Teachers
  const teacherDefs = [
    ['Dr. Arun Sharma', 'arun@schoolexpo.com', 'sub-math', 'Mathematics'],
    ['Ms. Priya Nair', 'priya@schoolexpo.com', 'sub-physics', 'Physics'],
    ['Mr. Ravi Kumar', 'ravi@schoolexpo.com', 'sub-chemistry', 'Chemistry'],
  ];
  const teacherHash = bcrypt.hashSync('teacher123', 8);
  const teacherIds = teacherDefs.map(([name, email, subject_id, subject_name]) => {
    const id = crypto.randomUUID();
    store.users.push({
      id,
      name,
      email,
      password_hash: teacherHash,
      role: 'teacher',
      class_name: '12 A',
      assigned_classes: ['12 A'],
      subject_id,
      subject_name,
      created_at: now.toISOString(),
    });
    return id;
  });

  // Students
  const studentDefs = [
    ['Mohamed Fahd', 'aarav@schoolexpo.com', '2024001', 2850, 14],
    ['Amina Sidheeg', 'ananya@schoolexpo.com', '2024002', 3620, 21],
    ['Nazreena Dilip', 'arjun@schoolexpo.com', '2024003', 3180, 12],
    ['Fasna Sherin', 'diya@schoolexpo.com', '2024004', 2490, 9],
    ['Swathi Bijukumar', 'ishaan@schoolexpo.com', '2024005', 1940, 7],
    ['Hisham Muhammad', 'kavya@schoolexpo.com', '2024006', 3410, 18],
    ['Muhammed Saad', 'rohan@schoolexpo.com', '2024007', 1620, 5],
    ['Muhammed Abdullah', 'saanvi@schoolexpo.com', '2024008', 2270, 11],
    ['Dev Sreekumar', 'vihaan@schoolexpo.com', '2024009', 1350, 4],
  ];
  const studentHash = bcrypt.hashSync('student123', 8);
  const studentIds = studentDefs.map(([name, email, roll_number, xp, streak]) => {
    const id = crypto.randomUUID();
    store.users.push({
      id,
      name,
      email,
      password_hash: studentHash,
      role: 'student',
      class_name: '12 A',
      roll_number,
      section: 'A',
      created_at: now.toISOString(),
    });
    const lvl = getLevel(xp);
    store.xp_profiles.push({
      user_id: id,
      total_xp: xp,
      level: lvl.level,
      streak,
      last_activity: now.toISOString(),
      created_at: now.toISOString(),
    });
    return id;
  });

  // Chapters & Topics
  store.chapters = [
    { id: 'ch-math-1', subject_id: 'sub-math', subject_name: 'Mathematics', name: 'Sets & Relations', order_index: 1, status: 'completed' },
    { id: 'ch-math-2', subject_id: 'sub-math', subject_name: 'Mathematics', name: 'Trigonometry', order_index: 2, status: 'ongoing' },
    { id: 'ch-math-3', subject_id: 'sub-math', subject_name: 'Mathematics', name: 'Calculus Basics', order_index: 3, status: 'upcoming' },
    { id: 'ch-phy-1', subject_id: 'sub-physics', subject_name: 'Physics', name: 'Kinematics', order_index: 1, status: 'completed' },
    { id: 'ch-phy-2', subject_id: 'sub-physics', subject_name: 'Physics', name: 'Laws of Motion', order_index: 2, status: 'ongoing' },
    { id: 'ch-phy-3', subject_id: 'sub-physics', subject_name: 'Physics', name: 'Work, Energy & Power', order_index: 3, status: 'upcoming' },
    { id: 'ch-chem-1', subject_id: 'sub-chemistry', subject_name: 'Chemistry', name: 'Atomic Structure', order_index: 1, status: 'completed' },
    { id: 'ch-chem-2', subject_id: 'sub-chemistry', subject_name: 'Chemistry', name: 'Chemical Bonding', order_index: 2, status: 'ongoing' },
  ];

  const topicData = {
    'ch-math-1': ['Introduction to Sets', 'Types of Sets', 'Venn Diagrams', 'Operations on Sets', 'Relations'],
    'ch-math-2': ['Angles & Measurement', 'Trigonometric Ratios', 'Trigonometric Identities', 'Graphs of Trig Functions'],
    'ch-math-3': ['Limits', 'Continuity', 'Differentiation Basics'],
    'ch-phy-1': ['Distance & Displacement', 'Speed & Velocity', 'Acceleration', 'Equations of Motion', 'Projectile Motion'],
    'ch-phy-2': ["Newton's First Law", "Newton's Second Law", "Newton's Third Law", 'Friction'],
    'ch-phy-3': ['Work Done by Force', 'Kinetic Energy', 'Potential Energy', 'Conservation of Energy'],
    'ch-chem-1': ['Discovery of Electron', 'Rutherford Model', 'Bohr Model', 'Quantum Mechanical Model'],
    'ch-chem-2': ['Ionic Bond', 'Covalent Bond', 'Metallic Bond', 'VSEPR Theory'],
  };

  for (const [chId, topics] of Object.entries(topicData)) {
    const ch = store.chapters.find((c) => c.id === chId);
    const chStatus = ch ? ch.status : 'upcoming';
    topics.forEach((topicName, idx) => {
      const tStatus =
        chStatus === 'completed'
          ? 'completed'
          : chStatus === 'ongoing' && idx === 0
          ? 'ongoing'
          : 'upcoming';
      store.topics.push({
        id: crypto.randomUUID(),
        chapter_id: chId,
        name: topicName,
        order_index: idx + 1,
        status: tStatus,
      });
    });
  }

  // Assignments
  store.assignments = [
    {
      id: 'asg-1',
      subject_id: 'sub-math',
      subject_name: 'Mathematics',
      subject_color: '#6366f1',
      title: 'Sets & Relations Practice',
      description: 'Complete exercises 1.1 to 1.5 from NCERT textbook. Show all working.',
      due_date: daysFromNow(3),
      max_marks: 20,
      xp_reward: 50,
      class_name: '12 A',
      created_by: teacherIds[0],
      created_at: daysAgo(2),
    },
    {
      id: 'asg-2',
      subject_id: 'sub-physics',
      subject_name: 'Physics',
      subject_color: '#22d3ee',
      title: 'Kinematics Numerical Problems',
      description: 'Solve 10 numerical problems on projectile motion. Use proper formulas and units.',
      due_date: daysFromNow(5),
      max_marks: 30,
      xp_reward: 75,
      class_name: '12 A',
      created_by: teacherIds[1],
      created_at: daysAgo(1),
    },
    {
      id: 'asg-3',
      subject_id: 'sub-chemistry',
      subject_name: 'Chemistry',
      subject_color: '#10b981',
      title: 'Atomic Structure Worksheet',
      description: 'Complete the worksheet on electron configuration and quantum numbers.',
      due_date: daysAgo(1),
      max_marks: 15,
      xp_reward: 40,
      class_name: '12 A',
      created_by: teacherIds[2],
      created_at: daysAgo(7),
    },
    {
      id: 'asg-4',
      subject_id: 'sub-math',
      subject_name: 'Mathematics',
      subject_color: '#6366f1',
      title: 'Trigonometry Assignment',
      description: 'Prove the trigonometric identities listed in the assignment sheet.',
      due_date: daysFromNow(7),
      max_marks: 25,
      xp_reward: 60,
      class_name: '12 A',
      created_by: teacherIds[0],
      created_at: now.toISOString(),
    },
    {
      id: 'asg-5',
      subject_id: 'sub-physics',
      subject_name: 'Physics',
      subject_color: '#22d3ee',
      title: "Newton's Laws Lab Report",
      description: 'Write a detailed lab report on the experiments conducted in class.',
      due_date: daysFromNow(10),
      max_marks: 20,
      xp_reward: 50,
      class_name: '12 A',
      created_by: teacherIds[1],
      created_at: now.toISOString(),
    },
  ];

  // Submissions
  store.submissions = [
    {
      id: crypto.randomUUID(),
      assignment_id: 'asg-1',
      student_id: studentIds[0],
      student_name: studentDefs[0][0],
      status: 'graded',
      content: 'Completed all exercises.',
      marks_obtained: 18,
      feedback: 'Excellent work! Clear presentation.',
      submitted_at: daysAgo(1),
      graded_at: now.toISOString(),
    },
    {
      id: crypto.randomUUID(),
      assignment_id: 'asg-3',
      student_id: studentIds[0],
      student_name: studentDefs[0][0],
      status: 'submitted',
      content: 'Worksheet completed.',
      submitted_at: hoursAgo(12),
    },
  ];

  // Attendance (last 30 days)
  studentIds.forEach((sid, sIdx) => {
    for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
      const d = new Date(now.getTime() - dayOffset * 86400000);
      const day = d.getDay(); // 0=Sun, 6=Sat
      if (day === 0 || day === 6) continue;
      const dateStr = d.toISOString().split('T')[0];
      const isPresent = (dayOffset + sIdx) % 7 !== 0;
      store.attendance.push({
        student_id: sid,
        date: dateStr,
        is_present: isPresent,
        created_at: now.toISOString(),
      });
    }
  });

  // Exam Results
  const examNames = ['Unit Test 1', 'Mid-Term', 'Unit Test 2'];
  const baseScores = [82, 87, 91];
  studentIds.forEach((sid, sidIdx) => {
    store.subjects.slice(0, 3).forEach((subj, subjIdx) => {
      examNames.forEach((exam, examIdx) => {
        const marks = Math.min(98, Math.max(52, baseScores[examIdx] - (sidIdx % 4) * 5 + subjIdx * 2));
        const grade =
          marks >= 90 ? 'A+' : marks >= 80 ? 'A' : marks >= 70 ? 'B+' : marks >= 60 ? 'B' : 'C';
        store.results.push({
          id: crypto.randomUUID(),
          student_id: sid,
          subject_id: subj.id,
          subject_name: subj.name,
          exam_name: exam,
          marks_obtained: marks,
          total_marks: 100,
          percentage: marks,
          grade,
          exam_date: daysAgo(75 - examIdx * 25 + subjIdx * 2).split('T')[0],
          created_at: now.toISOString(),
        });
      });
    });
  });

  // DPP Sets & Questions
  store.dpp_sets = [
    {
      id: 'dpp-1',
      subject_id: 'sub-math',
      subject_name: 'Mathematics',
      title: 'Sets & Relations Quick Quiz',
      description: 'Test your understanding of sets, subsets, and Venn diagrams.',
      xp_reward: 30,
      time_limit: 600,
      question_count: 5,
      is_active: true,
      created_at: now.toISOString(),
    },
    {
      id: 'dpp-2',
      subject_id: 'sub-physics',
      subject_name: 'Physics',
      title: 'Kinematics MCQ Practice',
      description: 'Practice problems on velocity, acceleration, and equations of motion.',
      xp_reward: 30,
      time_limit: 600,
      question_count: 5,
      is_active: true,
      created_at: now.toISOString(),
    },
    {
      id: 'dpp-3',
      subject_id: 'sub-chemistry',
      subject_name: 'Chemistry',
      title: 'Atomic Structure Basics',
      description: 'Test your knowledge of atomic models and quantum numbers.',
      xp_reward: 30,
      time_limit: 600,
      question_count: 5,
      is_active: true,
      created_at: now.toISOString(),
    },
  ];

  store.questions = [
    { id: 'q-m1', dpp_set_id: 'dpp-1', question_text: 'If A = {1, 2, 3} and B = {2, 3, 4}, what is A ∩ B?', options: { A: '{2, 3}', B: '{1, 2, 3, 4}', C: '{1, 4}', D: '{}' }, correct_answer: 'A', explanation: 'A ∩ B contains elements common to both sets: {2, 3}', difficulty: 'EASY', marks: 1, order_index: 1 },
    { id: 'q-m2', dpp_set_id: 'dpp-1', question_text: 'What is the power set of {a, b}?', options: { A: '{{a}, {b}}', B: '{∅, {a}, {b}, {a,b}}', C: '{{a,b}}', D: '{a, b}' }, correct_answer: 'B', explanation: 'Power set includes all possible subsets including empty set and the set itself.', difficulty: 'MEDIUM', marks: 1, order_index: 2 },
    { id: 'q-m3', dpp_set_id: 'dpp-1', question_text: 'If n(A) = 10, n(B) = 15, n(A∪B) = 20, find n(A∩B).', options: { A: '3', B: '5', C: '7', D: '10' }, correct_answer: 'B', explanation: 'Using n(A∪B) = n(A) + n(B) - n(A∩B): 20 = 10 + 15 - n(A∩B), so n(A∩B) = 5', difficulty: 'MEDIUM', marks: 1, order_index: 3 },
    { id: 'q-m4', dpp_set_id: 'dpp-1', question_text: 'A relation R on set A is symmetric if:', options: { A: 'aRb → bRa', B: 'aRa for all a', C: 'aRb and bRc → aRc', D: 'None of these' }, correct_answer: 'A', explanation: 'A symmetric relation means if (a,b) ∈ R then (b,a) ∈ R.', difficulty: 'EASY', marks: 1, order_index: 4 },
    { id: 'q-m5', dpp_set_id: 'dpp-1', question_text: 'Which of the following is an equivalence relation on Z?', options: { A: 'a > b', B: 'a - b is even', C: 'a × b > 0', D: 'a + b is odd' }, correct_answer: 'B', explanation: 'a - b being even is reflexive, symmetric, and transitive — all properties of equivalence relation.', difficulty: 'HARD', marks: 1, order_index: 5 },

    { id: 'q-p1', dpp_set_id: 'dpp-2', question_text: 'A car accelerates from rest at 2 m/s². What is its velocity after 5 seconds?', options: { A: '5 m/s', B: '10 m/s', C: '15 m/s', D: '20 m/s' }, correct_answer: 'B', explanation: 'v = u + at = 0 + 2(5) = 10 m/s', difficulty: 'EASY', marks: 1, order_index: 1 },
    { id: 'q-p2', dpp_set_id: 'dpp-2', question_text: 'A ball is thrown vertically upward with velocity 20 m/s. Maximum height reached is: (g=10m/s²)', options: { A: '10 m', B: '20 m', C: '30 m', D: '40 m' }, correct_answer: 'B', explanation: 'H = u²/2g = 400/20 = 20m', difficulty: 'MEDIUM', marks: 1, order_index: 2 },
    { id: 'q-p3', dpp_set_id: 'dpp-2', question_text: 'The slope of a velocity-time graph gives:', options: { A: 'Distance', B: 'Displacement', C: 'Acceleration', D: 'Speed' }, correct_answer: 'C', explanation: 'The slope of v-t graph represents the rate of change of velocity, which is acceleration.', difficulty: 'EASY', marks: 1, order_index: 3 },
    { id: 'q-p4', dpp_set_id: 'dpp-2', question_text: 'A projectile is launched at 45°. Its range is maximum when:', options: { A: 'Height is maximum', B: 'Angle is 45°', C: 'Initial velocity is minimum', D: 'None' }, correct_answer: 'B', explanation: 'Range R = u²sin(2θ)/g is maximum when sin(2θ) = 1, i.e., θ = 45°', difficulty: 'MEDIUM', marks: 1, order_index: 4 },
    { id: 'q-p5', dpp_set_id: 'dpp-2', question_text: 'Displacement is a _____ quantity.', options: { A: 'Scalar', B: 'Vector', C: 'Tensor', D: 'Dimensionless' }, correct_answer: 'B', explanation: 'Displacement has both magnitude and direction, making it a vector quantity.', difficulty: 'EASY', marks: 1, order_index: 5 },

    { id: 'q-c1', dpp_set_id: 'dpp-3', question_text: 'Who discovered the electron?', options: { A: 'Rutherford', B: 'Bohr', C: 'J.J. Thomson', D: 'Dalton' }, correct_answer: 'C', explanation: 'J.J. Thomson discovered the electron through cathode ray experiments in 1897.', difficulty: 'EASY', marks: 1, order_index: 1 },
    { id: 'q-c2', dpp_set_id: 'dpp-3', question_text: "The quantum number 'l' represents:", options: { A: 'Size of orbital', B: 'Shape of orbital', C: 'Orientation', D: 'Spin' }, correct_answer: 'B', explanation: 'The azimuthal quantum number (l) determines the shape of the orbital.', difficulty: 'MEDIUM', marks: 1, order_index: 2 },
    { id: 'q-c3', dpp_set_id: 'dpp-3', question_text: 'Maximum electrons in 3rd shell:', options: { A: '8', B: '18', C: '32', D: '2' }, correct_answer: 'B', explanation: 'Maximum electrons = 2n² = 2(3²) = 18', difficulty: 'EASY', marks: 1, order_index: 3 },
    { id: 'q-c4', dpp_set_id: 'dpp-3', question_text: "Heisenberg's uncertainty principle states:", options: { A: 'Energy is quantized', B: "Position and momentum can't be measured simultaneously with precision", C: 'Electrons move in orbits', D: 'Atoms are indivisible' }, correct_answer: 'B', explanation: 'Δx × Δp ≥ ℏ/2 — position and momentum have inherent uncertainty.', difficulty: 'MEDIUM', marks: 1, order_index: 4 },
    { id: 'q-c5', dpp_set_id: 'dpp-3', question_text: 'The Aufbau principle states:', options: { A: 'No two electrons have same quantum numbers', B: 'Electrons fill lowest energy orbitals first', C: 'Orbitals are half-filled before pairing', D: 'Electrons are waves' }, correct_answer: 'B', explanation: "Aufbau (German for 'building up') principle: electrons fill orbitals in order of increasing energy.", difficulty: 'EASY', marks: 1, order_index: 5 },
  ];

  // Timetable (Mon-Fri)
  store.timetable = [
    { class_name: '12 A', subject_id: 'sub-math', subject_name: 'Mathematics', subject_color: '#6366f1', day_of_week: 1, start_time: '09:00', end_time: '09:45', room: 'Room 201' },
    { class_name: '12 A', subject_id: 'sub-physics', subject_name: 'Physics', subject_color: '#22d3ee', day_of_week: 1, start_time: '09:45', end_time: '10:30', room: 'Lab 1' },
    { class_name: '12 A', subject_id: 'sub-chemistry', subject_name: 'Chemistry', subject_color: '#10b981', day_of_week: 1, start_time: '11:00', end_time: '11:45', room: 'Lab 2' },
    { class_name: '12 A', subject_id: 'sub-english', subject_name: 'English', subject_color: '#f59e0b', day_of_week: 1, start_time: '11:45', end_time: '12:30', room: 'Room 201' },
    { class_name: '12 A', subject_id: 'sub-cs', subject_name: 'Computer Science', subject_color: '#8b5cf6', day_of_week: 1, start_time: '14:00', end_time: '14:45', room: 'Computer Lab' },
    { class_name: '12 A', subject_id: 'sub-math', subject_name: 'Mathematics', subject_color: '#6366f1', day_of_week: 2, start_time: '09:00', end_time: '09:45', room: 'Room 201' },
    { class_name: '12 A', subject_id: 'sub-chemistry', subject_name: 'Chemistry', subject_color: '#10b981', day_of_week: 2, start_time: '09:45', end_time: '10:30', room: 'Lab 2' },
    { class_name: '12 A', subject_id: 'sub-physics', subject_name: 'Physics', subject_color: '#22d3ee', day_of_week: 2, start_time: '11:00', end_time: '11:45', room: 'Lab 1' },
    { class_name: '12 A', subject_id: 'sub-math', subject_name: 'Mathematics', subject_color: '#6366f1', day_of_week: 3, start_time: '09:00', end_time: '09:45', room: 'Room 201' },
    { class_name: '12 A', subject_id: 'sub-physics', subject_name: 'Physics', subject_color: '#22d3ee', day_of_week: 3, start_time: '09:45', end_time: '10:30', room: 'Lab 1' },
    { class_name: '12 A', subject_id: 'sub-cs', subject_name: 'Computer Science', subject_color: '#8b5cf6', day_of_week: 4, start_time: '09:00', end_time: '09:45', room: 'Computer Lab' },
    { class_name: '12 A', subject_id: 'sub-math', subject_name: 'Mathematics', subject_color: '#6366f1', day_of_week: 4, start_time: '10:00', end_time: '10:45', room: 'Room 201' },
    { class_name: '12 A', subject_id: 'sub-english', subject_name: 'English', subject_color: '#f59e0b', day_of_week: 5, start_time: '09:00', end_time: '09:45', room: 'Room 201' },
    { class_name: '12 A', subject_id: 'sub-chemistry', subject_name: 'Chemistry', subject_color: '#10b981', day_of_week: 5, start_time: '10:00', end_time: '10:45', room: 'Lab 2' },
  ];

  // Announcements
  store.announcements = [
    {
      id: crypto.randomUUID(),
      author_id: adminId,
      author_name: 'Admin',
      title: 'Mid-Term Exams Schedule Released',
      content: 'The mid-term examination schedule has been uploaded. Please check the notice board.',
      priority: 'HIGH',
      created_at: daysAgo(1),
    },
    {
      id: crypto.randomUUID(),
      author_id: teacherIds[0],
      author_name: 'Dr. Arun Sharma',
      title: 'Extra Math Class on Saturday',
      content: 'There will be an extra mathematics class this Saturday from 10 AM to 12 PM for trigonometry revision.',
      priority: 'NORMAL',
      created_at: hoursAgo(5),
    },
    {
      id: crypto.randomUUID(),
      author_id: adminId,
      author_name: 'Admin',
      title: 'Science Fair Registration Open',
      content: 'Register for the annual science fair by next Friday. Teams of 2-3 students allowed.',
      priority: 'NORMAL',
      created_at: daysAgo(3),
    },
  ];

  // Notifications
  for (const sid of studentIds.slice(0, 3)) {
    store.notifications.push(
      { id: crypto.randomUUID(), user_id: sid, title: 'New Assignment', message: 'Sets & Relations Practice has been posted.', type: 'assignment', is_read: false, created_at: hoursAgo(2) },
      { id: crypto.randomUUID(), user_id: sid, title: 'XP Earned!', message: 'You earned 50 XP for submitting an assignment.', type: 'xp', is_read: false, created_at: hoursAgo(1) },
      { id: crypto.randomUUID(), user_id: sid, title: 'Attendance Alert', message: 'Your attendance in Physics dropped below 80%.', type: 'attendance', is_read: true, created_at: daysAgo(2) }
    );
  }

  // Todos for first student
  store.todos = [
    { id: crypto.randomUUID(), user_id: studentIds[0], title: 'Review Trigonometry Identities', description: 'Chapters 3.1 - 3.4 notes', is_important: true, is_completed: false, status: 'todo', due_date: daysFromNow(1), subject_tag: 'Mathematics', created_at: hoursAgo(6) },
    { id: crypto.randomUUID(), user_id: studentIds[0], title: 'Solve Kinematics DPP', description: 'Complete 5 MCQs before evening', is_important: false, is_completed: true, status: 'done', due_date: now.toISOString(), subject_tag: 'Physics', created_at: daysAgo(1) },
  ];

  // XP events for first student
  store.xp_events = [
    { user_id: studentIds[0], amount: 50, reason: 'assignment_submitted', created_at: daysAgo(1) },
    { user_id: studentIds[0], amount: 30, reason: 'assignment_graded_above_80', created_at: hoursAgo(10) },
    { user_id: studentIds[0], amount: 5, reason: 'todo_completed', created_at: hoursAgo(3) },
  ];

  // Studycast
  store.studycast = [
    { id: 'sc-1', title: 'Calculus 101: Limits & Continuity', subject_id: 'sub-math', subject_name: 'Mathematics', instructor: 'Dr. Sunita Rao', duration_seconds: 1320, duration_label: '22 min', description: 'An introductory deep-dive into limits, continuity, and the epsilon-delta definition.', thumbnail_color: '#6366f1', created_at: daysAgo(10) },
    { id: 'sc-2', title: "Newton's Laws Deep Dive - Part 1", subject_id: 'sub-physics', subject_name: 'Physics', instructor: 'Mr. Rakesh Nair', duration_seconds: 1080, duration_label: '18 min', description: "Understanding Newton's first and second laws with real-world examples.", thumbnail_color: '#22d3ee', created_at: daysAgo(8) },
    { id: 'sc-3', title: "Newton's Laws Deep Dive - Part 2", subject_id: 'sub-physics', subject_name: 'Physics', instructor: 'Mr. Rakesh Nair', duration_seconds: 1440, duration_label: '24 min', description: "Newton's third law, friction forces, and advanced applications.", thumbnail_color: '#22d3ee', created_at: daysAgo(7) },
    { id: 'sc-4', title: 'The Periodic Table: Periods & Groups', subject_id: 'sub-chemistry', subject_name: 'Chemistry', instructor: 'Ms. Preethi', duration_seconds: 900, duration_label: '15 min', description: 'Navigate the periodic table like a pro - periods, groups, and trends.', thumbnail_color: '#10b981', created_at: daysAgo(5) },
    { id: 'sc-5', title: "Shakespeare's Hamlet: Act 1 Analysis", subject_id: 'sub-english', subject_name: 'English', instructor: 'Mr. James', duration_seconds: 1800, duration_label: '30 min', description: 'Literary analysis of Act 1, exploring themes of revenge and morality.', thumbnail_color: '#f59e0b', created_at: daysAgo(4) },
    { id: 'sc-6', title: 'Python OOP: Classes & Objects', subject_id: 'sub-cs', subject_name: 'Computer Science', instructor: 'Ms. Kavya Menon', duration_seconds: 1200, duration_label: '20 min', description: 'Master object-oriented programming with Python classes and inheritance.', thumbnail_color: '#8b5cf6', created_at: daysAgo(3) },
    { id: 'sc-7', title: 'Trigonometry Master Class', subject_id: 'sub-math', subject_name: 'Mathematics', instructor: 'Dr. Sunita Rao', duration_seconds: 2100, duration_label: '35 min', description: 'Complete guide to trigonometric ratios, identities, and graphs.', thumbnail_color: '#6366f1', created_at: daysAgo(2) },
    { id: 'sc-8', title: 'Organic Chemistry: Hydrocarbons', subject_id: 'sub-chemistry', subject_name: 'Chemistry', instructor: 'Ms. Preethi', duration_seconds: 1680, duration_label: '28 min', description: 'Alkanes, alkenes, alkynes - nomenclature, properties, and reactions.', thumbnail_color: '#10b981', created_at: daysAgo(1) },
  ];

  // Invoices & Seeded Demo Payment Transactions
  const invoiceStatuses = ['PAID', 'PAID', 'PARTIAL', 'OVERDUE', 'UNPAID'];
  const feeCategories = [
    {
      label: 'Tuition Fee - Term 1',
      amount: 12500,
      gst_amount: 2250,
      line_items: [
        { label: 'Academic Tuition (Term 1)', amount: 10500, gst_amount: 1890 },
        { label: 'Digital Campus & Library Access', amount: 2000, gst_amount: 360 },
      ],
      issueDaysAgo: 30,
      dueOffsetDays: -18,
    },
    {
      label: 'Campus Transport - Q1',
      amount: 3500,
      gst_amount: 175,
      line_items: [
        { label: 'School Bus Route Pass (Q1)', amount: 3000, gst_amount: 150 },
        { label: 'GPS Safety & Tracking Service', amount: 500, gst_amount: 25 },
      ],
      issueDaysAgo: 25,
      dueOffsetDays: -12,
    },
    {
      label: 'Tuition Fee - Term 2',
      amount: 12500,
      gst_amount: 2250,
      line_items: [
        { label: 'Academic Tuition (Term 2)', amount: 10500, gst_amount: 1890 },
        { label: 'Continuous Assessment & Lab Support', amount: 2000, gst_amount: 360 },
      ],
      issueDaysAgo: 14,
      dueOffsetDays: 12,
    },
    {
      label: 'Books & Academic Kit',
      amount: 2000,
      gst_amount: 240,
      line_items: [
        { label: 'Textbooks & Reference Modules', amount: 1400, gst_amount: 168 },
        { label: 'Printed Practice Workbooks', amount: 600, gst_amount: 72 },
      ],
      issueDaysAgo: 20,
      dueOffsetDays: -5,
    },
    {
      label: 'Science & CS Lab Fee',
      amount: 1500,
      gst_amount: 270,
      line_items: [
        { label: 'Physics & Chemistry Lab Consumables', amount: 900, gst_amount: 162 },
        { label: 'Computer Science Cloud Sandbox', amount: 600, gst_amount: 108 },
      ],
      issueDaysAgo: 6,
      dueOffsetDays: 20,
    },
  ];

  studentIds.forEach((sid, sidIdx) => {
    const sname = studentDefs[sidIdx][0];
    const sroll = studentDefs[sidIdx][2];
    for (let invIdx = 0; invIdx < 5; invIdx++) {
      const fee = feeCategories[invIdx];
      const subtotal = fee.amount;
      const gst = fee.gst_amount;
      const cgst = roundCurrency(gst / 2);
      const sgst = roundCurrency(gst / 2);
      const total = roundCurrency(subtotal + gst);
      const status = invoiceStatuses[(invIdx + sidIdx) % 5];
      const amount_paid = status === 'PAID' ? total : status === 'PARTIAL' ? Math.min(total - 1000, 8000) : 0;
      const balance_due = roundCurrency(Math.max(0, total - amount_paid));
      const invNum = String(sidIdx * 5 + invIdx + 1).padStart(3, '0');
      const issueDate = toDateOnly(daysAgo(fee.issueDaysAgo));
      const dueDate =
        status === 'PAID'
          ? toDateOnly(daysAgo(Math.max(8, Math.abs(fee.dueOffsetDays))))
          : status === 'OVERDUE'
            ? toDateOnly(daysAgo(5))
            : status === 'PARTIAL'
              ? toDateOnly(daysFromNow(12))
              : toDateOnly(daysFromNow(20));

      const invId = `inv-${sidIdx + 1}-${invIdx + 1}`;
      const invNumber = `INV-2026-${invNum}`;
      const createdAt = daysAgo(fee.issueDaysAgo);
      const paidAt = amount_paid > 0 ? daysAgo(Math.max(2, fee.issueDaysAgo - 4)) : null;

      store.invoices.push({
        id: invId,
        invoice_number: invNumber,
        student_id: sid,
        student_name: sname,
        class_name: '12 A',
        roll_number: sroll,
        academic_year: SCHOOL_IDENTITY.academic_year,
        category: fee.label,
        line_items: fee.line_items,
        subtotal,
        cgst,
        sgst,
        total_amount: total,
        amount_paid,
        balance_due,
        status,
        issue_date: issueDate,
        due_date: dueDate,
        paid_at: paidAt,
        billing_v2: true,
        created_at: createdAt,
      });

      if (amount_paid > 0) {
        const seq = String(store.payment_transactions.length + 1).padStart(4, '0');
        const dateToken = toDateOnly(paidAt).replace(/-/g, '');
        store.payment_transactions.push({
          id: `txn-seed-${invId}`,
          invoice_id: invId,
          invoice_number: invNumber,
          invoice_category: fee.label,
          student_id: sid,
          student_name: sname,
          class_name: '12 A',
          roll_number: sroll,
          paid_by_user_id: sid,
          paid_by_name: sname,
          paid_by_role: 'student',
          amount: amount_paid,
          balance_after: balance_due,
          invoice_status_after: status,
          payment_method: status === 'PARTIAL' ? 'UPI' : 'NET_BANKING',
          method_detail:
            status === 'PARTIAL'
              ? `${sname.split(' ')[0].toLowerCase()}@demoupi`
              : 'Demo National Bank •••• 1024',
          status: 'SUCCESS',
          is_demo: true,
          mode: 'DEMO',
          demo_notice: 'Exhibition Demonstration — No real money charged',
          reference_number: `DEMO-TXN-${dateToken}-${seq}`,
          receipt_number: `RCPT-2026-${seq}`,
          idempotency_key: `seed-${invId}`,
          paid_at: paidAt,
          created_at: paidAt,
        });
      }
    }
  });

  // Chat Rooms & Messages
  store.chat_rooms = [
    { id: 'room-general', name: 'General', type: 'group', subject_id: null, icon: 'hash', description: 'General discussion for all students' },
    { id: 'room-math', name: 'Mathematics', type: 'subject', subject_id: 'sub-math', icon: 'calculator', description: 'Math doubts and discussions', color: '#6366f1' },
    { id: 'room-physics', name: 'Physics', type: 'subject', subject_id: 'sub-physics', icon: 'atom', description: 'Physics discussions', color: '#22d3ee' },
    { id: 'room-chemistry', name: 'Chemistry', type: 'subject', subject_id: 'sub-chemistry', icon: 'flask-conical', description: 'Chemistry discussions', color: '#10b981' },
    { id: 'room-cs', name: 'Computer Science', type: 'subject', subject_id: 'sub-cs', icon: 'code', description: 'CS discussions', color: '#8b5cf6' },
  ];

  store.chat_messages = [
    { id: crypto.randomUUID(), room_id: 'room-general', sender_id: studentIds[0], sender_name: studentDefs[0][0], content: 'Hey everyone! Has anyone started the math assignment?', type: 'TEXT', read_by: [studentIds[0]], created_at: hoursAgo(5) },
    { id: crypto.randomUUID(), room_id: 'room-general', sender_id: studentIds[1], sender_name: studentDefs[1][0], content: "Yes! It's not too hard if you review chapter 1 notes first.", type: 'TEXT', read_by: [studentIds[1]], created_at: hoursAgo(4) },
    { id: crypto.randomUUID(), room_id: 'room-general', sender_id: studentIds[2], sender_name: studentDefs[2][0], content: 'Thanks for the tip! Good luck everyone.', type: 'TEXT', read_by: [studentIds[2]], created_at: hoursAgo(3) },
    { id: crypto.randomUUID(), room_id: 'room-math', sender_id: studentIds[0], sender_name: studentDefs[0][0], content: 'Can someone explain the difference between injective and surjective functions?', type: 'TEXT', read_by: [studentIds[0]], created_at: hoursAgo(2) },
    { id: crypto.randomUUID(), room_id: 'room-math', sender_id: studentIds[3], sender_name: studentDefs[3][0], content: 'Injective = one-to-one (no two inputs map to same output). Surjective = onto (every output has at least one input).', type: 'TEXT', read_by: [studentIds[3]], created_at: hoursAgo(1) },
  ];
}

if (!loadStore()) {
  seedData();
  normalizeStore();
  saveStore();
}

// ============================================================
// API ROUTER
// ============================================================
const api = express.Router();

// --- AUTH ---
api.post('/auth/login', (req, res) => {
  const email = (req.body?.email || '').toLowerCase().trim();
  const password = req.body?.password || '';
  const user = store.users.find((u) => u.email === email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ detail: 'Invalid email or password' });
  }

  const accessToken = createAccessToken(user.id, email, user.role);
  const refreshToken = createRefreshToken(user.id);

  res.cookie('access_token', accessToken, { httpOnly: true, secure: false, sameSite: 'lax', maxAge: 3600000, path: '/' });
  res.cookie('refresh_token', refreshToken, { httpOnly: true, secure: false, sameSite: 'lax', maxAge: 604800000, path: '/' });
  user.last_login_at = new Date().toISOString();

  return res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    avatar_url: user.avatar_url || null,
    class_name: user.class_name || null,
    roll_number: user.roll_number || null,
    access_token: accessToken,
  });
});

api.post('/auth/logout', (_req, res) => {
  res.clearCookie('access_token', { path: '/' });
  res.clearCookie('refresh_token', { path: '/' });
  return res.json({ message: 'Logged out' });
});

api.get('/auth/me', requireAuth, (req, res) => {
  const xpProfile = store.xp_profiles.find((p) => p.user_id === req.user.id) || null;
  return res.json({ ...req.user, xp_profile: xpProfile });
});

api.post('/auth/refresh', (req, res) => {
  const token = req.cookies?.refresh_token;
  if (!token) {
    return res.status(401).json({ detail: 'No refresh token' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== 'refresh') {
      return res.status(401).json({ detail: 'Invalid token type' });
    }
    const user = store.users.find((u) => u.id === payload.sub);
    if (!user) {
      return res.status(401).json({ detail: 'User not found' });
    }
    const accessToken = createAccessToken(user.id, user.email, user.role);
    res.cookie('access_token', accessToken, { httpOnly: true, secure: false, sameSite: 'lax', maxAge: 3600000, path: '/' });
    return res.json({ access_token: accessToken });
  } catch {
    return res.status(401).json({ detail: 'Invalid refresh token' });
  }
});

// --- DASHBOARDS ---
api.get('/dashboard/student', requireAuth, (req, res) => {
  const uid = req.user.id;
  const now = new Date();
  const nowIso = now.toISOString();

  const xpProfile = store.xp_profiles.find((p) => p.user_id === uid) || { total_xp: 0, level: 1, streak: 0 };

  const upcomingAssignments = store.assignments
    .filter((a) => a.class_name === req.user.class_name && a.due_date >= nowIso)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
    .slice(0, 5);

  const attRecords = store.attendance.filter((r) => r.student_id === uid);
  const totalAtt = attRecords.length;
  const presentAtt = attRecords.filter((r) => r.is_present).length;
  const attPct = totalAtt > 0 ? Math.round((presentAtt / totalAtt) * 1000) / 10 : 100;

  const recentResults = store.results
    .filter((r) => r.student_id === uid)
    .sort((a, b) => b.exam_date.localeCompare(a.exam_date))
    .slice(0, 5);
  const avgScore =
    recentResults.length > 0
      ? Math.round((recentResults.reduce((acc, r) => acc + (r.percentage || 0), 0) / recentResults.length) * 10) / 10
      : 0;

  const allXp = [...store.xp_profiles].sort((a, b) => (b.total_xp || 0) - (a.total_xp || 0));
  const rankIdx = allXp.findIndex((x) => x.user_id === uid);
  const rank = rankIdx >= 0 ? rankIdx + 1 : 0;

  const notifs = store.notifications
    .filter((n) => n.user_id === uid)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 5);

  const announcements = [...store.announcements]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 5);

  const jsDay = now.getDay();
  const dayOfWeek = jsDay === 0 ? 7 : jsDay; // 1=Mon..7=Sun
  const schedule = store.timetable
    .filter((t) => t.class_name === req.user.class_name && t.day_of_week === dayOfWeek)
    .sort((a, b) => a.start_time.localeCompare(b.start_time));

  const levelInfo = getLevel(xpProfile.total_xp || 0);
  const nextLevel = LEVELS.find((lvl) => lvl.min_xp > (xpProfile.total_xp || 0)) || null;

  return res.json({
    xp_profile: { ...xpProfile, level_title: levelInfo.title, next_level: nextLevel },
    upcoming_assignments: upcomingAssignments,
    attendance_percentage: attPct,
    average_score: avgScore,
    leaderboard_rank: rank,
    recent_results: recentResults,
    notifications: notifs,
    announcements,
    schedule,
    streak: xpProfile.streak || 0,
  });
});

api.get('/dashboard/teacher', requireAuth, (req, res) => {
  if (req.user.role !== 'teacher' && req.user.role !== 'admin') {
    return res.status(403).json({ detail: 'Teachers only' });
  }

  const pending = store.submissions.filter((s) => s.status === 'submitted').length;
  const totalStudents = store.users.filter((u) => u.role === 'student').length;
  const recentAssignments = [...store.assignments]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 5);

  const subjMap = {};
  for (const r of store.results) {
    if (!subjMap[r.subject_name]) subjMap[r.subject_name] = [];
    subjMap[r.subject_name].push(r.percentage || 0);
  }
  const classAverages = Object.entries(subjMap).map(([subject, vals]) => ({
    subject,
    average: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10,
  }));

  const topStudentsXp = [...store.xp_profiles]
    .sort((a, b) => (b.total_xp || 0) - (a.total_xp || 0))
    .slice(0, 5);
  const topStudents = topStudentsXp
    .map((xp) => {
      const u = store.users.find((usr) => usr.id === xp.user_id);
      if (!u) return null;
      return {
        id: xp.user_id,
        name: u.name,
        class_name: u.class_name,
        total_xp: xp.total_xp,
        level: xp.level,
      };
    })
    .filter(Boolean);

  const announcements = [...store.announcements]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 5);

  return res.json({
    pending_grading: pending,
    total_students: totalStudents,
    recent_assignments: recentAssignments,
    class_averages: classAverages,
    top_students: topStudents,
    announcements,
  });
});

// --- ASSIGNMENTS & CLASSES ---
const ALLOWED_ATTACHMENT_EXTS = new Set(['.pdf', '.doc', '.docx', '.txt', '.md', '.png', '.jpg', '.jpeg']);
const ALLOWED_ATTACHMENT_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'application/octet-stream',
  '',
]);
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024; // 2 MB

function getTeacherAssignedClasses(user) {
  if (!user) return [];
  if (user.role === 'admin') {
    return [...new Set(store.users.filter((u) => u.role === 'student' && u.class_name).map((u) => u.class_name))];
  }
  const classes = Array.isArray(user.assigned_classes) && user.assigned_classes.length > 0
    ? user.assigned_classes
    : user.class_name
      ? [user.class_name]
      : [];
  return [...new Set(classes)];
}

function teacherCanAccessClass(user, className) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'teacher') return false;
  const assigned = getTeacherAssignedClasses(user);
  return assigned.includes(className);
}

function sanitizeFilename(rawName) {
  const base = path.basename(String(rawName || 'attachment')).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.slice(0, 120) || 'attachment';
}

function validateAttachment(attachment) {
  if (!attachment) return { ok: true, value: null };
  if (typeof attachment !== 'object') {
    return { ok: false, detail: 'Invalid attachment format' };
  }
  const fileName = sanitizeFilename(attachment.file_name || attachment.name);
  const ext = path.extname(fileName).toLowerCase();
  if (!ALLOWED_ATTACHMENT_EXTS.has(ext)) {
    return {
      ok: false,
      detail: 'Unsupported file format. Allowed: PDF, DOC, DOCX, TXT, MD, PNG, JPG',
    };
  }
  const mimeType = String(attachment.mime_type || attachment.type || '').toLowerCase().trim();
  if (!ALLOWED_ATTACHMENT_MIMES.has(mimeType)) {
    return { ok: false, detail: 'Unsupported attachment MIME type' };
  }
  const rawBase64 = String(attachment.data_base64 || '').replace(/^data:[^;]+;base64,/, '').trim();
  if (!rawBase64) {
    return { ok: false, detail: 'Attached file is empty' };
  }
  let buf;
  try {
    buf = Buffer.from(rawBase64, 'base64');
  } catch {
    return { ok: false, detail: 'Corrupted file payload' };
  }
  if (!buf || buf.length === 0) {
    return { ok: false, detail: 'Attached file contains no bytes' };
  }
  if (buf.length > MAX_ATTACHMENT_BYTES) {
    return { ok: false, detail: 'File exceeds the 2 MB maximum size limit' };
  }
  const fallbackMime =
    ext === '.pdf'
      ? 'application/pdf'
      : ext === '.png'
        ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.md'
            ? 'text/markdown'
            : ext === '.txt'
              ? 'text/plain'
              : 'application/octet-stream';

  return {
    ok: true,
    value: {
      file_name: fileName,
      mime_type: mimeType && mimeType !== 'application/octet-stream' ? mimeType : fallbackMime,
      size_bytes: buf.length,
      data_base64: buf.toString('base64'),
    },
  };
}

function sanitizeSubmission(sub) {
  if (!sub) return null;
  const { attachment, ...rest } = sub;
  const student = store.users.find((u) => u.id === sub.student_id);
  const safeAttachment = attachment
    ? {
        file_name: attachment.file_name,
        mime_type: attachment.mime_type,
        size_bytes: attachment.size_bytes,
        download_url: `/api/assignments/${sub.assignment_id}/submissions/${sub.id}/attachment`,
      }
    : null;
  return {
    ...rest,
    student_roll_number: student?.roll_number || null,
    student_class: student?.class_name || null,
    has_attachment: Boolean(safeAttachment),
    attachment: safeAttachment,
    history: Array.isArray(sub.history) ? sub.history : [],
  };
}

function enrichAssignmentForTeacher(a) {
  const subs = store.submissions.filter((s) => s.assignment_id === a.id);
  const totalStudents = store.users.filter((u) => u.role === 'student' && u.class_name === a.class_name).length;
  const gradedCount = subs.filter((s) => s.status === 'graded').length;
  const pendingCount = subs.filter((s) => s.status === 'submitted').length;
  return {
    ...a,
    status: a.status || 'published',
    submission_count: subs.length,
    graded_count: gradedCount,
    pending_count: pendingCount,
    total_students: totalStudents,
  };
}

api.get('/teacher/classes', requireAuth, (req, res) => {
  if (!['teacher', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ detail: 'Teachers only' });
  }
  const classNames = getTeacherAssignedClasses(req.user);
  const classes = classNames.map((className) => {
    const students = store.users.filter((u) => u.role === 'student' && u.class_name === className);
    const classAssignments = store.assignments.filter((a) => a.class_name === className);
    const classAssignmentIds = new Set(classAssignments.map((a) => a.id));
    const pendingGrading = store.submissions.filter(
      (s) => classAssignmentIds.has(s.assignment_id) && s.status === 'submitted'
    ).length;
    const subjects = store.subjects.filter((s) => !s.class_name || s.class_name === className);
    return {
      class_name: className,
      student_count: students.length,
      assignment_count: classAssignments.length,
      published_count: classAssignments.filter((a) => (a.status || 'published') === 'published').length,
      draft_count: classAssignments.filter((a) => a.status === 'draft').length,
      pending_grading: pendingGrading,
      subjects,
      primary_subject: req.user.subject_name || 'All Subjects',
    };
  });
  return res.json(classes);
});

api.get('/assignments', requireAuth, (req, res) => {
  const { status, class_name } = req.query;
  let list = [...store.assignments];
  const nowIso = new Date().toISOString();

  if (req.user.role === 'student') {
    list = list.filter(
      (a) => a.class_name === req.user.class_name && (a.status || 'published') === 'published'
    );
    list.sort((a, b) => b.due_date.localeCompare(a.due_date));
    list = list.map((a) => {
      const sub = store.submissions.find((s) => s.assignment_id === a.id && s.student_id === req.user.id) || null;
      const user_status = sub ? sub.status : a.due_date < nowIso ? 'overdue' : 'posted';
      const teacher = store.users.find((u) => u.id === a.created_by);
      return {
        ...a,
        status: a.status || 'published',
        teacher_name: a.teacher_name || teacher?.name || 'Class Teacher',
        submission: sanitizeSubmission(sub),
        user_status,
      };
    });
    if (status && status !== 'all') {
      list = list.filter((a) => a.user_status === status);
    }
    return res.json(list);
  }

  if (['teacher', 'admin'].includes(req.user.role)) {
    const allowedClasses = getTeacherAssignedClasses(req.user);
    if (class_name) {
      if (!teacherCanAccessClass(req.user, class_name)) {
        return res.status(403).json({ detail: 'Not authorized for this class' });
      }
      list = list.filter((a) => a.class_name === class_name);
    } else if (req.user.role === 'teacher') {
      list = list.filter((a) => allowedClasses.includes(a.class_name));
    }
    list.sort((a, b) => (b.created_at || b.due_date).localeCompare(a.created_at || a.due_date));
    if (status && status !== 'all') {
      list = list.filter((a) => (a.status || 'published') === status);
    }
    return res.json(list.map(enrichAssignmentForTeacher));
  }

  return res.status(403).json({ detail: 'Unauthorized role' });
});

api.post('/assignments', requireAuth, (req, res) => {
  if (!['teacher', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ detail: 'Teachers only' });
  }
  const {
    subject_id,
    title,
    description = '',
    due_date,
    max_marks = 10,
    xp_reward = 50,
    class_name,
    status = 'published',
  } = req.body || {};

  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  if (!cleanTitle) {
    return res.status(400).json({ detail: 'Assignment title is required' });
  }

  const subject = store.subjects.find((s) => s.id === subject_id);
  if (!subject) {
    return res.status(400).json({ detail: 'Please select a valid subject' });
  }

  const targetClass = class_name || req.user.class_name || '12 A';
  if (!teacherCanAccessClass(req.user, targetClass)) {
    return res.status(403).json({ detail: 'You are not assigned to publish for this class' });
  }

  const parsedMaxMarks = Number(max_marks);
  if (!Number.isFinite(parsedMaxMarks) || parsedMaxMarks < 1 || parsedMaxMarks > 1000) {
    return res.status(400).json({ detail: 'Max marks must be between 1 and 1000' });
  }

  const parsedXp = Number(xp_reward);
  if (!Number.isFinite(parsedXp) || parsedXp < 0 || parsedXp > 1000) {
    return res.status(400).json({ detail: 'XP reward must be between 0 and 1000' });
  }

  const parsedDueDate = due_date ? new Date(due_date) : new Date(Date.now() + 7 * 86400000);
  if (Number.isNaN(parsedDueDate.getTime())) {
    return res.status(400).json({ detail: 'Invalid due date' });
  }

  const normalizedStatus = status === 'draft' ? 'draft' : 'published';
  const nowIso = new Date().toISOString();

  const assignment = {
    id: crypto.randomUUID(),
    subject_id,
    subject_name: subject.name,
    subject_color: subject.color,
    title: cleanTitle,
    description: typeof description === 'string' ? description.trim() : '',
    due_date: parsedDueDate.toISOString(),
    max_marks: Math.round(parsedMaxMarks),
    xp_reward: Math.round(parsedXp),
    class_name: targetClass,
    status: normalizedStatus,
    created_by: req.user.id,
    teacher_name: req.user.name,
    created_at: nowIso,
    published_at: normalizedStatus === 'published' ? nowIso : null,
  };
  store.assignments.push(assignment);

  if (normalizedStatus === 'published') {
    const classStudents = store.users.filter((u) => u.role === 'student' && u.class_name === targetClass);
    for (const student of classStudents) {
      store.notifications.push({
        id: crypto.randomUUID(),
        user_id: student.id,
        title: `New ${subject.name} Assignment`,
        message: `${req.user.name} published "${cleanTitle}". Due ${parsedDueDate.toLocaleDateString()}.`,
        type: 'assignment',
        is_read: false,
        created_at: nowIso,
      });
    }
  }

  saveStore();
  return res.json(enrichAssignmentForTeacher(assignment));
});

api.post('/assignments/:assignmentId/publish', requireAuth, (req, res) => {
  if (!['teacher', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ detail: 'Teachers only' });
  }
  const assignment = store.assignments.find((a) => a.id === req.params.assignmentId);
  if (!assignment) {
    return res.status(404).json({ detail: 'Assignment not found' });
  }
  if (!teacherCanAccessClass(req.user, assignment.class_name)) {
    return res.status(403).json({ detail: 'Not authorized for this class' });
  }
  if (assignment.status === 'published') {
    return res.json(enrichAssignmentForTeacher(assignment));
  }

  const nowIso = new Date().toISOString();
  assignment.status = 'published';
  assignment.published_at = nowIso;

  const classStudents = store.users.filter((u) => u.role === 'student' && u.class_name === assignment.class_name);
  for (const student of classStudents) {
    store.notifications.push({
      id: crypto.randomUUID(),
      user_id: student.id,
      title: `New ${assignment.subject_name} Assignment`,
      message: `${req.user.name} published "${assignment.title}".`,
      type: 'assignment',
      is_read: false,
      created_at: nowIso,
    });
  }

  saveStore();
  return res.json(enrichAssignmentForTeacher(assignment));
});

api.get('/assignments/:assignmentId', requireAuth, (req, res) => {
  const a = store.assignments.find((x) => x.id === req.params.assignmentId);
  if (!a) return res.status(404).json({ detail: 'Assignment not found' });

  if (req.user.role === 'student') {
    if (a.class_name !== req.user.class_name || (a.status || 'published') !== 'published') {
      return res.status(403).json({ detail: 'Not authorized to view this assignment' });
    }
    const sub = store.submissions.find((s) => s.assignment_id === a.id && s.student_id === req.user.id) || null;
    const nowIso = new Date().toISOString();
    const user_status = sub ? sub.status : a.due_date < nowIso ? 'overdue' : 'posted';
    const teacher = store.users.find((u) => u.id === a.created_by);
    return res.json({
      ...a,
      status: a.status || 'published',
      teacher_name: a.teacher_name || teacher?.name || 'Class Teacher',
      user_status,
      submission: sanitizeSubmission(sub),
    });
  }

  if (['teacher', 'admin'].includes(req.user.role)) {
    if (!teacherCanAccessClass(req.user, a.class_name)) {
      return res.status(403).json({ detail: 'Not authorized for this class' });
    }
    return res.json(enrichAssignmentForTeacher(a));
  }

  return res.status(403).json({ detail: 'Unauthorized' });
});

api.post('/assignments/:assignmentId/submit', requireAuth, (req, res) => {
  if (req.user.role !== 'student') {
    return res.status(403).json({ detail: 'Students only' });
  }
  const { assignmentId } = req.params;
  const assignment = store.assignments.find((a) => a.id === assignmentId);
  if (!assignment) {
    return res.status(404).json({ detail: 'Assignment not found' });
  }
  if (assignment.class_name !== req.user.class_name) {
    return res.status(403).json({ detail: 'You are not enrolled in this class' });
  }
  if ((assignment.status || 'published') !== 'published') {
    return res.status(400).json({ detail: 'Assignment is not published yet' });
  }

  const existing = store.submissions.find((s) => s.assignment_id === assignmentId && s.student_id === req.user.id);
  if (existing) {
    return res.status(400).json({ detail: 'Already submitted' });
  }

  const cleanContent = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  const attachmentValidation = validateAttachment(req.body?.attachment);
  if (!attachmentValidation.ok) {
    return res.status(400).json({ detail: attachmentValidation.detail });
  }
  const validatedAttachment = attachmentValidation.value;

  if (!cleanContent && !validatedAttachment) {
    return res.status(400).json({ detail: 'Please write a response or attach a supported file before submitting' });
  }

  const nowIso = new Date().toISOString();
  const isFirstEverSubmission = !store.submissions.some((s) => s.student_id === req.user.id);
  const xpRewardAmount = Number(assignment.xp_reward) > 0 ? Number(assignment.xp_reward) : XP_REWARDS.assignment_submitted;

  const submission = {
    id: crypto.randomUUID(),
    assignment_id: assignmentId,
    student_id: req.user.id,
    student_name: req.user.name,
    status: 'submitted',
    content: cleanContent,
    attachment: validatedAttachment,
    submitted_at: nowIso,
    history: [
      {
        id: crypto.randomUUID(),
        action: 'submitted',
        actor_name: req.user.name,
        actor_role: 'student',
        timestamp: nowIso,
        note: validatedAttachment
          ? `Submitted${cleanContent ? ' written response and' : ''} file "${validatedAttachment.file_name}"`
          : 'Submitted written response',
      },
    ],
  };

  store.submissions.push(submission);
  const xpResult = awardXp(req.user.id, xpRewardAmount, 'assignment_submitted');
  if (isFirstEverSubmission) {
    awardXp(req.user.id, XP_REWARDS.first_submission, 'first_submission');
  }

  store.notifications.push({
    id: crypto.randomUUID(),
    user_id: req.user.id,
    title: 'Assignment Submitted!',
    message: `You submitted "${assignment.title}" and earned ${xpRewardAmount} XP!`,
    type: 'xp',
    is_read: false,
    created_at: nowIso,
  });

  if (assignment.created_by) {
    store.notifications.push({
      id: crypto.randomUUID(),
      user_id: assignment.created_by,
      title: 'New Student Submission',
      message: `${req.user.name} submitted "${assignment.title}".`,
      type: 'assignment',
      is_read: false,
      created_at: nowIso,
    });
  }

  saveStore();
  return res.json({ ...sanitizeSubmission(submission), xp_earned: xpResult });
});

api.get('/assignments/:assignmentId/submissions', requireAuth, (req, res) => {
  if (!['teacher', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ detail: 'Teachers only' });
  }
  const assignment = store.assignments.find((a) => a.id === req.params.assignmentId);
  if (!assignment) {
    return res.status(404).json({ detail: 'Assignment not found' });
  }
  if (!teacherCanAccessClass(req.user, assignment.class_name)) {
    return res.status(403).json({ detail: 'Not authorized for this class' });
  }
  const subs = store.submissions
    .filter((s) => s.assignment_id === req.params.assignmentId)
    .sort((a, b) => (b.submitted_at || '').localeCompare(a.submitted_at || ''))
    .map(sanitizeSubmission);
  return res.json(subs);
});

api.get('/assignments/:assignmentId/submissions/:submissionId/attachment', requireAuth, (req, res) => {
  const assignment = store.assignments.find((a) => a.id === req.params.assignmentId);
  if (!assignment) {
    return res.status(404).json({ detail: 'Assignment not found' });
  }
  const sub = store.submissions.find(
    (s) => s.id === req.params.submissionId && s.assignment_id === assignment.id
  );
  if (!sub) {
    return res.status(404).json({ detail: 'Submission not found' });
  }

  const isOwningStudent = req.user.role === 'student' && sub.student_id === req.user.id;
  const isAuthorizedTeacher = ['teacher', 'admin'].includes(req.user.role) && teacherCanAccessClass(req.user, assignment.class_name);
  if (!isOwningStudent && !isAuthorizedTeacher) {
    return res.status(403).json({ detail: 'Not authorized to access this file' });
  }
  if (!sub.attachment || !sub.attachment.data_base64) {
    return res.status(404).json({ detail: 'No attachment on this submission' });
  }

  const fileBuf = Buffer.from(sub.attachment.data_base64, 'base64');
  const safeName = sanitizeFilename(sub.attachment.file_name);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', sub.attachment.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  return res.send(fileBuf);
});

api.post('/assignments/:assignmentId/grade/:submissionId', requireAuth, (req, res) => {
  if (!['teacher', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ detail: 'Teachers only' });
  }
  const assignment = store.assignments.find((a) => a.id === req.params.assignmentId);
  if (!assignment) {
    return res.status(404).json({ detail: 'Assignment not found' });
  }
  if (!teacherCanAccessClass(req.user, assignment.class_name)) {
    return res.status(403).json({ detail: 'Not authorized to grade for this class' });
  }

  const sub = store.submissions.find(
    (s) => s.id === req.params.submissionId && s.assignment_id === assignment.id
  );
  if (!sub) {
    return res.status(404).json({ detail: 'Submission not found for this assignment' });
  }

  const rawMarks = req.body?.marks_obtained;
  if (rawMarks === undefined || rawMarks === null || rawMarks === '') {
    return res.status(400).json({ detail: 'Marks are required' });
  }
  const marksObtained = Number(rawMarks);
  const maxMarks = assignment.max_marks || 10;
  if (!Number.isFinite(marksObtained) || marksObtained < 0 || marksObtained > maxMarks) {
    return res.status(400).json({ detail: `Marks must be between 0 and ${maxMarks}` });
  }

  const cleanMarks = Math.round(marksObtained * 10) / 10;
  const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback.trim().slice(0, 2000) : '';
  const nowIso = new Date().toISOString();
  const wasAlreadyGraded = sub.status === 'graded';

  sub.status = 'graded';
  sub.marks_obtained = cleanMarks;
  sub.feedback = feedback;
  sub.graded_at = nowIso;
  sub.graded_by = req.user.id;
  sub.graded_by_name = req.user.name;

  if (!Array.isArray(sub.history)) sub.history = [];
  sub.history.push({
    id: crypto.randomUUID(),
    action: wasAlreadyGraded ? 'regraded' : 'graded',
    actor_name: req.user.name,
    actor_role: req.user.role,
    timestamp: nowIso,
    marks_obtained: cleanMarks,
    max_marks: maxMarks,
    note: feedback || (wasAlreadyGraded ? 'Updated grade' : 'Grade published'),
  });

  if (!sub.distinction_xp_awarded && cleanMarks >= maxMarks * 0.8) {
    sub.distinction_xp_awarded = true;
    awardXp(sub.student_id, XP_REWARDS.assignment_graded_above_80, 'assignment_graded_above_80');
  }

  store.notifications.push({
    id: crypto.randomUUID(),
    user_id: sub.student_id,
    title: wasAlreadyGraded ? 'Assignment Grade Updated' : 'Assignment Graded!',
    message: `${req.user.name} graded "${assignment.title}": ${cleanMarks}/${maxMarks}`,
    type: 'assignment',
    is_read: false,
    created_at: nowIso,
  });

  saveStore();
  return res.json({
    message: wasAlreadyGraded ? 'Grade updated successfully' : 'Graded successfully',
    submission: sanitizeSubmission(sub),
  });
});

// --- ATTENDANCE ---
api.get('/attendance', requireAuth, (req, res) => {
  if (req.user.role === 'student') {
    const records = store.attendance
      .filter((r) => r.student_id === req.user.id)
      .sort((a, b) => b.date.localeCompare(a.date));
    const total = records.length;
    const present = records.filter((r) => r.is_present).length;
    const percentage = total > 0 ? Math.round((present / total) * 1000) / 10 : 100;
    return res.json({ records, total, present, percentage });
  }
  const students = store.users.filter((u) => u.role === 'student').map(sanitizeUser);
  return res.json({ students });
});

api.get('/attendance/class', requireAuth, (req, res) => {
  if (!['teacher', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ detail: 'Teachers only' });
  }
  const targetDate = req.query.date || new Date().toISOString().split('T')[0];
  const records = store.attendance.filter((r) => r.date === targetDate);
  const students = store.users
    .filter((u) => u.role === 'student')
    .map((s) => {
      const att = records.find((r) => r.student_id === s.id);
      return {
        id: s.id,
        name: s.name,
        roll_number: s.roll_number || '',
        class_name: s.class_name || '',
        is_present: att ? att.is_present : null,
      };
    });
  return res.json({ date: targetDate, students });
});

api.post('/attendance/mark', requireAuth, (req, res) => {
  if (!['teacher', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ detail: 'Teachers only' });
  }
  const { student_ids = [], date, present_ids = [], subject = null } = req.body || {};
  const presentSet = new Set(present_ids);
  for (const sid of student_ids) {
    const is_present = presentSet.has(sid);
    const existing = store.attendance.find((r) => r.student_id === sid && r.date === date);
    if (existing) {
      existing.is_present = is_present;
      existing.subject = subject;
      existing.marked_by = req.user.id;
    } else {
      store.attendance.push({
        student_id: sid,
        date,
        is_present,
        subject,
        marked_by: req.user.id,
        created_at: new Date().toISOString(),
      });
    }
  }
  return res.json({ message: `Attendance marked for ${student_ids.length} students` });
});

// --- RESULTS ---
api.get('/results', requireAuth, (req, res) => {
  let results =
    req.user.role === 'student'
      ? store.results.filter((r) => r.student_id === req.user.id)
      : [...store.results];
  results.sort((a, b) => b.exam_date.localeCompare(a.exam_date));
  return res.json(results);
});

api.get('/results/analytics', requireAuth, (req, res) => {
  const results = store.results
    .filter((r) => r.student_id === req.user.id)
    .sort((a, b) => a.exam_date.localeCompare(b.exam_date));

  if (results.length === 0) {
    return res.json({ trend: [], subject_performance: [], summary: {} });
  }

  const trend = results.map((r) => ({
    exam: r.exam_name,
    percentage: r.percentage,
    date: r.exam_date,
  }));

  const subjectScores = {};
  for (const r of results) {
    const subj = r.subject_name || 'Unknown';
    if (!subjectScores[subj]) subjectScores[subj] = [];
    subjectScores[subj].push(r.percentage);
  }

  const subject_performance = Object.entries(subjectScores).map(([subject, vals]) => ({
    subject,
    average: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10,
    latest: vals[vals.length - 1],
  }));

  const best = subject_performance.reduce((a, b) => (b.average > a.average ? b : a), subject_performance[0]);
  const weakest = subject_performance.reduce((a, b) => (b.average < a.average ? b : a), subject_performance[0]);
  const highest = results.reduce((a, b) => (b.percentage > a.percentage ? b : a), results[0]);
  const overall_average =
    Math.round((results.reduce((acc, r) => acc + r.percentage, 0) / results.length) * 10) / 10;

  return res.json({
    trend,
    subject_performance,
    summary: {
      best_subject: best ? best.subject : null,
      weakest_subject: weakest ? weakest.subject : null,
      highest_score: highest ? highest.percentage : 0,
      overall_average,
    },
  });
});

// --- DPP ---
api.get('/dpp', requireAuth, (req, res) => {
  const { subject } = req.query;
  let sets = store.dpp_sets.filter((s) => s.is_active);
  if (subject) sets = sets.filter((s) => s.subject_name === subject);

  sets = sets.map((s) => {
    if (req.user.role === 'student') {
      const attempt = store.dpp_attempts.find((a) => a.dpp_set_id === s.id && a.student_id === req.user.id) || null;
      return { ...s, attempted: Boolean(attempt), last_attempt: attempt };
    }
    return { ...s };
  });
  return res.json(sets);
});

api.get('/dpp/:dppId', requireAuth, (req, res) => {
  const dpp = store.dpp_sets.find((s) => s.id === req.params.dppId);
  if (!dpp) return res.status(404).json({ detail: 'DPP not found' });

  let questions = store.questions
    .filter((q) => q.dpp_set_id === dpp.id)
    .sort((a, b) => a.order_index - b.order_index)
    .map((q) => ({ ...q }));

  if (req.user.role === 'student') {
    const attempt = store.dpp_attempts.find((a) => a.dpp_set_id === dpp.id && a.student_id === req.user.id);
    if (!attempt) {
      questions = questions.map(({ correct_answer, explanation, ...rest }) => rest);
    }
  }

  return res.json({ ...dpp, questions });
});

api.post('/dpp/:dppId/attempt', requireAuth, (req, res) => {
  if (req.user.role !== 'student') {
    return res.status(403).json({ detail: 'Students only' });
  }
  const dpp = store.dpp_sets.find((s) => s.id === req.params.dppId);
  if (!dpp) return res.status(404).json({ detail: 'DPP not found' });

  const questions = store.questions.filter((q) => q.dpp_set_id === dpp.id);
  const answers = req.body?.answers || {};
  const timeTaken = Number(req.body?.time_taken) || 0;

  let score = 0;
  let total_marks = 0;
  const results_detail = questions.map((q) => {
    const marks = q.marks || 1;
    total_marks += marks;
    const user_answer = answers[q.id] || '';
    const is_correct = user_answer === q.correct_answer;
    if (is_correct) score += marks;
    return {
      question_id: q.id,
      user_answer,
      correct_answer: q.correct_answer,
      is_correct,
      explanation: q.explanation || '',
    };
  });

  const attempt = {
    id: crypto.randomUUID(),
    dpp_set_id: dpp.id,
    student_id: req.user.id,
    answers,
    score,
    total_marks,
    time_taken: timeTaken,
    completed_at: new Date().toISOString(),
  };

  const existingIdx = store.dpp_attempts.findIndex(
    (a) => a.dpp_set_id === dpp.id && a.student_id === req.user.id
  );
  if (existingIdx >= 0) {
    store.dpp_attempts[existingIdx] = attempt;
  } else {
    store.dpp_attempts.push(attempt);
  }

  const isPerfect = score === total_marks && total_marks > 0;
  const xp_earned = awardXp(
    req.user.id,
    isPerfect ? XP_REWARDS.dpp_perfect_score : XP_REWARDS.dpp_completed,
    isPerfect ? 'dpp_perfect_score' : 'dpp_completed'
  );

  return res.json({ ...attempt, results_detail, xp_earned });
});

// --- LEADERBOARD ---
api.get('/leaderboard', requireAuth, (req, res) => {
  const { class_name } = req.query;
  const profiles = [...store.xp_profiles].sort((a, b) => (b.total_xp || 0) - (a.total_xp || 0));

  const leaderboard = [];
  for (const p of profiles) {
    const u = store.users.find((usr) => usr.id === p.user_id);
    if (!u || u.role !== 'student') continue;
    if (class_name && u.class_name !== class_name) continue;
    const lvl = getLevel(p.total_xp || 0);
    leaderboard.push({
      rank: leaderboard.length + 1,
      user_id: p.user_id,
      name: u.name,
      avatar_url: u.avatar_url || null,
      class_name: u.class_name,
      total_xp: p.total_xp,
      level: lvl.level,
      level_title: lvl.title,
      streak: p.streak || 0,
    });
  }

  const current_user = leaderboard.find((e) => e.user_id === req.user.id) || null;
  return res.json({ leaderboard: leaderboard.slice(0, 50), current_user });
});

// --- TODOS ---
api.get('/todos', requireAuth, (req, res) => {
  const todos = store.todos
    .filter((t) => t.user_id === req.user.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return res.json(todos);
});

api.post('/todos', requireAuth, (req, res) => {
  const { title, description = '', is_important = false, due_date = null, subject_tag = null } = req.body || {};
  const todo = {
    id: crypto.randomUUID(),
    user_id: req.user.id,
    title,
    description,
    is_important: Boolean(is_important),
    is_completed: false,
    status: 'todo',
    due_date,
    subject_tag,
    created_at: new Date().toISOString(),
  };
  store.todos.push(todo);
  return res.json(todo);
});

api.patch('/todos/:todoId', requireAuth, (req, res) => {
  const todo = store.todos.find((t) => t.id === req.params.todoId && t.user_id === req.user.id);
  if (!todo) return res.status(404).json({ detail: 'Todo not found' });

  const updates = req.body || {};
  if (updates.title !== undefined) todo.title = updates.title;
  if (updates.description !== undefined) todo.description = updates.description;
  if (updates.is_important !== undefined) todo.is_important = updates.is_important;
  if (updates.status !== undefined) todo.status = updates.status;
  if (updates.due_date !== undefined) todo.due_date = updates.due_date;
  if (updates.is_completed !== undefined) {
    const newlyCompleted = updates.is_completed && !todo.is_completed;
    todo.is_completed = Boolean(updates.is_completed);
    if (newlyCompleted) {
      todo.completed_at = new Date().toISOString();
      awardXp(req.user.id, XP_REWARDS.todo_completed, 'todo_completed');
    }
  }
  return res.json(todo);
});

api.delete('/todos/:todoId', requireAuth, (req, res) => {
  store.todos = store.todos.filter((t) => !(t.id === req.params.todoId && t.user_id === req.user.id));
  return res.json({ message: 'Deleted' });
});

// --- AI ROUTES (Server-Side @google/genai) ---
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

api.get('/ai/status', requireAuth, (_req, res) => {
  const configured = Boolean(process.env.GEMINI_API_KEY);
  return res.json({
    configured,
    mode: configured ? 'live' : 'demo',
    model: 'gemini-4-hydrogen',
  });
});

function buildTutorSystemInstruction(mode, subject, user) {
  const levelInfo = user?.class_name ? `Class ${user.class_name}` : 'High School (Class 12)';
  const subjectContext = subject && subject !== 'All Subjects' ? `Focused Subject: ${subject}.` : 'Subject: General Academic.';

  if (mode === 'hint') {
    return [
      `You are The Oxford School AI Study Coach in HINT MODE helping ${user?.name || 'a student'} (${levelInfo}). ${subjectContext}`,
      'CRITICAL PEDAGOGICAL RULE: Never immediately reveal the final answer or complete worked solution on the first or second hint.',
      'Instead, guide the student step by step using progressive hints:',
      '- Look at the conversation history to see how many hints have already been given on the current problem.',
      '- On the first hint: identify the core concept or relevant formula, acknowledge what is given, and suggest only the first setup step, then ask the student what they get.',
      '- On follow-up hints or if the student submits a partial attempt: validate what they did right, gently point out any misconception, and offer the next single bridge step.',
      '- Only reveal the full solution if the student explicitly asks to see the complete solution or has clearly tried across 3+ hints.',
      'Keep each hint focused, encouraging, concise, and formatted cleanly with markdown.'
    ].join('\n');
  }

  return [
    `You are The Oxford School AI Study Companion in EXPLAIN MODE tutoring ${user?.name || 'a student'} (${levelInfo}). ${subjectContext}`,
    'Explain concepts clearly in simple, engaging language tailored to the student level.',
    'Always organize your explanation using these exact markdown headings in order:',
    '## Concept Overview',
    '1-2 clear sentences giving the core intuition.',
    '## Step-by-Step Explanation',
    'Numbered points breaking down how it works.',
    '## Worked Example',
    'A concrete numerical or practical classroom example solved step by step.',
    '## Important Formulas',
    'Key equations or rules in inline/fenced code formatting (or state key grammar/conceptual rules if non-numerical).',
    '## Key Takeaway',
    'One memorable summary sentence the student can carry into an exam.'
  ].join('\n');
}

api.post('/ai/chat', requireAuth, async (req, res) => {
  const {
    message,
    session_id,
    mode = 'explain',
    subject = 'All Subjects',
    history = [],
  } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ detail: 'Message is required', error: true });
  }

  const normalizedMode = ['explain', 'hint'].includes(mode) ? mode : 'explain';
  const cleanMessage = message.trim();

  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      detail: 'GEMINI_API_KEY is not configured on the server.',
      error: true,
    });
  }

  try {
    const safeHistory = Array.isArray(history)
      ? history
          .filter((item) => item && typeof item.content === 'string' && item.content.trim())
          .slice(-10)
          .map((item) => ({
            role: item.role === 'assistant' || item.role === 'model' ? 'model' : 'user',
            parts: [{ text: item.content.trim() }],
          }))
      : [];

    const contents = [
      ...safeHistory,
      { role: 'user', parts: [{ text: cleanMessage }] },
    ];

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents,
      config: {
        systemInstruction: buildTutorSystemInstruction(normalizedMode, subject, req.user),
      },
    });

    const text = (response.text || '').trim();
    if (!text) {
      return res.status(502).json({
        detail: 'The AI model returned an empty response. Please try rephrasing your question.',
        error: true,
      });
    }

    store.ai_chats.push({
      user_id: req.user.id,
      session_id,
      mode: normalizedMode,
      subject,
      user_message: cleanMessage,
      ai_response: text,
      created_at: new Date().toISOString(),
    });

    return res.json({
      response: text,
      session_id,
      mode: normalizedMode,
      subject,
    });
  } catch (err) {
    console.error('AI chat error:', err);
    return res.status(err.status || 500).json({
      detail: err.message || 'Failed to generate AI response.',
      error: true,
    });
  }
});

api.post('/ai/quiz', requireAuth, async (req, res) => {
  const {
    topic,
    subject = 'All Subjects',
    difficulty = 'medium',
    question_count = 4,
  } = req.body || {};

  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    return res.status(400).json({ detail: 'Quiz topic is required', error: true });
  }

  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      detail: 'GEMINI_API_KEY is not configured on the server.',
      error: true,
    });
  }

  const count = Math.min(6, Math.max(2, Number(question_count) || 4));
  const cleanDifficulty = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'medium';
  const cleanSubject = typeof subject === 'string' && subject.trim() ? subject.trim() : 'All Subjects';
  const cleanTopic = topic.trim();

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Generate a ${count}-question ${cleanDifficulty} multiple-choice practice quiz for a ${req.user.class_name || 'Class 12'} student.\nSubject: ${cleanSubject}\nTopic: ${cleanTopic}\nEach question must have exactly 4 distinct options with keys A, B, C, and D, one unambiguous correct_key matching A, B, C, or D, and a concise explanation teaching why that answer is correct.`,
      config: {
        systemInstruction:
          'You are an expert high-school curriculum assessment designer. Produce clear, accurate, unambiguous multiple-choice questions calibrated to the requested subject, topic, and difficulty.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            subject: { type: Type.STRING },
            topic: { type: Type.STRING },
            questions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  question: { type: Type.STRING },
                  options: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        key: { type: Type.STRING },
                        text: { type: Type.STRING },
                      },
                      required: ['key', 'text'],
                    },
                  },
                  correct_key: { type: Type.STRING },
                  explanation: { type: Type.STRING },
                },
                required: ['id', 'question', 'options', 'correct_key', 'explanation'],
              },
            },
          },
          required: ['title', 'subject', 'topic', 'questions'],
        },
      },
    });

    const rawText = (response.text ?? '{}').trim();
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return res.status(502).json({
        detail: 'Failed to parse generated quiz structure from AI response. Please try again.',
        error: true,
      });
    }

    if (!parsed || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
      return res.status(502).json({
        detail: 'AI did not return valid quiz questions. Please try another topic.',
        error: true,
      });
    }

    return res.json({
      quiz: {
        title: parsed.title || `${cleanTopic} Practice Quiz`,
        subject: parsed.subject || cleanSubject,
        topic: parsed.topic || cleanTopic,
        difficulty: cleanDifficulty,
        questions: parsed.questions.map((q, idx) => ({
          id: q.id || `q-${idx + 1}`,
          question: q.question,
          options: Array.isArray(q.options) ? q.options.slice(0, 4) : [],
          correct_key: String(q.correct_key || 'A').trim().toUpperCase().charAt(0),
          explanation: q.explanation || '',
        })),
      },
    });
  } catch (err) {
    console.error('AI quiz error:', err);
    return res.status(err.status || 500).json({
      detail: err.message || 'Unable to generate practice quiz.',
      error: true,
    });
  }
});

api.post('/ai/study-plan', requireAuth, async (req, res) => {
  const {
    message = '',
    subject = 'All Subjects',
    daily_hours = 2,
    goal = '',
  } = req.body || {};

  const ai = getGeminiClient();
  if (!ai) {
    return res.status(503).json({
      detail: 'GEMINI_API_KEY is not configured on the server.',
      error: true,
    });
  }

  try {
    const results = store.results.filter((r) => r.student_id === req.user.id).slice(-6);
    const submittedIds = new Set(
      store.submissions.filter((s) => s.student_id === req.user.id).map((s) => s.assignment_id)
    );
    const pendingAssignments = store.assignments
      .filter((a) => (!req.user.class_name || a.class_name === req.user.class_name) && !submittedIds.has(a.id))
      .slice(0, 6);
    const openTodos = store.todos
      .filter((t) => t.user_id === req.user.id && !t.is_completed && !t.completed)
      .slice(0, 6);

    const hours = Math.min(10, Math.max(0.5, Number(daily_hours) || 2));
    let context = `Student: ${req.user.name}, Class: ${req.user.class_name || 'N/A'}\n`;
    context += `Preferred Focus Subject: ${subject}\n`;
    context += `Available Daily Study Hours: ${hours} hours/day\n`;

    if (results.length > 0) {
      context += '\nRecent exam results:\n';
      for (const r of results) {
        context += `- ${r.subject_name}: ${r.percentage}% in ${r.exam_name}\n`;
      }
    }
    if (pendingAssignments.length > 0) {
      context += '\nPending assignments:\n';
      for (const a of pendingAssignments) {
        context += `- ${a.title} (${a.subject_name}, due ${a.due_date})\n`;
      }
    }
    if (openTodos.length > 0) {
      context += '\nOpen study tasks:\n';
      for (const t of openTodos) {
        context += `- ${t.title} [${t.priority || 'MEDIUM'}]\n`;
      }
    }

    const userFocusPrompt = [goal, message].filter(Boolean).join(' ').trim();

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `${context}\n\nCreate a practical 7-day (Monday to Sunday) weekly study planner tailored to the student data above. Include 2 focused study blocks per day fitting within ${hours}h/day.${userFocusPrompt ? `\nStudent request: ${userFocusPrompt}` : ''}`,
      config: {
        systemInstruction:
          'You are an expert academic advisor for The Oxford School. Build a realistic 7-day weekly study planner grounded in the student’s actual scores, pending assignments, open tasks, and daily study budget. Prioritize weaker subjects and upcoming deadlines.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            summary: { type: Type.STRING },
            days: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  day: { type: Type.STRING },
                  focus_subject: { type: Type.STRING },
                  total_duration: { type: Type.STRING },
                  priority: { type: Type.STRING },
                  blocks: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        time_slot: { type: Type.STRING },
                        subject: { type: Type.STRING },
                        topic: { type: Type.STRING },
                        duration: { type: Type.STRING },
                        activity_type: { type: Type.STRING },
                      },
                      required: ['time_slot', 'subject', 'topic', 'duration', 'activity_type'],
                    },
                  },
                },
                required: ['day', 'focus_subject', 'total_duration', 'priority', 'blocks'],
              },
            },
          },
          required: ['title', 'summary', 'days'],
        },
      },
    });

    const rawText = (response.text ?? '{}').trim();
    let parsedPlan = null;
    try {
      parsedPlan = JSON.parse(rawText);
    } catch {
      parsedPlan = null;
    }

    if (!parsedPlan || !Array.isArray(parsedPlan.days) || parsedPlan.days.length === 0) {
      return res.status(502).json({
        detail: 'The AI advisor returned an invalid study plan format. Please try again.',
        error: true,
      });
    }

    const markdownSummary = [
      `## ${parsedPlan.title || 'Weekly Study Plan'}`,
      parsedPlan.summary || '',
      ...parsedPlan.days.map(
        (d) =>
          `### ${d.day} · ${d.focus_subject} (${d.total_duration})\n- Priority: ${d.priority}`
      ),
    ].join('\n\n');

    return res.json({
      response: markdownSummary,
      plan: parsedPlan,
      context_summary: {
        recent_exams: results.length,
        pending_assignments: pendingAssignments.length,
        open_todos: openTodos.length,
        daily_hours: hours,
        subject,
      },
    });
  } catch (err) {
    console.error('Study plan error:', err);
    return res.status(err.status || 500).json({
      detail: err.message || 'Unable to generate study plan.',
      error: true,
    });
  }
});

// --- PROFILE ---
api.get('/profile', requireAuth, (req, res) => {
  const xpProfile = store.xp_profiles.find((p) => p.user_id === req.user.id) || { total_xp: 0, level: 1, streak: 0 };
  const xpHistory = store.xp_events
    .filter((e) => e.user_id === req.user.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 20);
  const levelInfo = getLevel(xpProfile.total_xp || 0);
  return res.json({
    ...req.user,
    school_name: SCHOOL_IDENTITY.name,
    xp_profile: { ...xpProfile, level_title: levelInfo.title },
    xp_history: xpHistory,
  });
});

api.patch('/profile', requireAuth, (req, res) => {
  const user = store.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ detail: 'User not found' });
  const { name, phone, address } = req.body || {};
  if (name !== undefined) user.name = name;
  if (phone !== undefined) user.phone = phone;
  if (address !== undefined) user.address = address;
  return res.json(sanitizeUser(user));
});

// --- NOTIFICATIONS ---
api.get('/notifications', requireAuth, (req, res) => {
  const notifications = store.notifications
    .filter((n) => n.user_id === req.user.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 50);
  const unread_count = notifications.filter((n) => !n.is_read).length;
  return res.json({ notifications, unread_count });
});

api.patch('/notifications/read-all', requireAuth, (req, res) => {
  for (const n of store.notifications) {
    if (n.user_id === req.user.id) n.is_read = true;
  }
  return res.json({ message: 'All read' });
});

// --- SUBJECTS & TIMELINE ---
api.get('/subjects', requireAuth, (_req, res) => {
  return res.json(store.subjects);
});

api.get('/timeline', requireAuth, (req, res) => {
  const { subject } = req.query;
  let chapters = [...store.chapters];
  if (subject) chapters = chapters.filter((c) => c.subject_id === subject);
  chapters.sort((a, b) => a.order_index - b.order_index);

  const enriched = chapters.map((ch) => {
    const topics = store.topics
      .filter((t) => t.chapter_id === ch.id)
      .sort((a, b) => a.order_index - b.order_index);
    const completed = topics.filter((t) => t.status === 'completed').length;
    const progress = topics.length > 0 ? Math.round((completed / topics.length) * 100) : 0;
    return { ...ch, topics, progress };
  });
  return res.json(enriched);
});

// --- STUDYCAST ---
async function enrichStudycastEpisode(ep, userId) {
  const progress =
    store.studycast_progress.find((p) => p.user_id === userId && p.episode_id === ep.id) || null;
  if (!PODCAST_EPISODE_IDS.has(ep.id)) {
    return { ...ep, progress };
  }

  let cachedInfo = null;
  try {
    cachedInfo = await getCachedAudioInfo(ep.id);
  } catch (err) {
    console.warn(`[Studycast] Failed to probe cached audio for ${ep.id}:`, err.message);
  }

  if (cachedInfo) {
    if (
      ep.duration_seconds !== cachedInfo.duration_seconds ||
      ep.duration_label !== cachedInfo.duration_label
    ) {
      ep.duration_seconds = cachedInfo.duration_seconds;
      ep.duration_label = cachedInfo.duration_label;
      saveStore();
    }
    return {
      ...ep,
      is_neural_podcast: true,
      has_audio: true,
      audio_url: cachedInfo.audio_url,
      duration_seconds: cachedInfo.duration_seconds,
      duration_label: cachedInfo.duration_label,
      progress,
    };
  }

  return {
    ...ep,
    is_neural_podcast: true,
    has_audio: false,
    audio_url: null,
    audio_status: process.env.GEMINI_API_KEY ? 'pending' : 'missing_credentials',
    progress,
  };
}

api.get('/studycast', requireAuth, async (req, res) => {
  const { subject } = req.query;
  let episodes = [...store.studycast];
  if (subject) episodes = episodes.filter((e) => e.subject_name === subject);
  episodes.sort((a, b) => b.created_at.localeCompare(a.created_at));

  const enriched = await Promise.all(episodes.map((ep) => enrichStudycastEpisode(ep, req.user.id)));
  return res.json(enriched);
});

api.get('/studycast/:episodeId', requireAuth, async (req, res) => {
  const ep = store.studycast.find((e) => e.id === req.params.episodeId);
  if (!ep) return res.status(404).json({ detail: 'Episode not found' });
  const enriched = await enrichStudycastEpisode(ep, req.user.id);
  return res.json(enriched);
});

api.post('/studycast/:episodeId/audio/prepare', requireAuth, async (req, res) => {
  const ep = store.studycast.find((e) => e.id === req.params.episodeId);
  if (!ep) return res.status(404).json({ detail: 'Episode not found' });
  if (!PODCAST_EPISODE_IDS.has(ep.id)) {
    return res.status(400).json({ detail: 'Neural podcast audio is only configured for episodes 1 and 2' });
  }
  try {
    const info = await ensureEpisodeAudio(ep.id);
    if (ep.duration_seconds !== info.duration_seconds || ep.duration_label !== info.duration_label) {
      ep.duration_seconds = info.duration_seconds;
      ep.duration_label = info.duration_label;
      saveStore();
    }
    return res.json({
      episode_id: ep.id,
      has_audio: true,
      audio_url: info.audio_url,
      duration_seconds: info.duration_seconds,
      duration_label: info.duration_label,
    });
  } catch (err) {
    console.error(`[Studycast] Prepare audio failed for ${ep.id}:`, err.message);
    const rawStatus = Number(err.status) || 500;
    const safeStatus = rawStatus >= 502 && rawStatus <= 504 ? 500 : rawStatus;
    return res.status(safeStatus).json({
      detail: err.message || 'Unable to prepare episode audio',
      code: err.code || 'AUDIO_GENERATION_FAILED',
      error: true,
    });
  }
});

api.options('/studycast/:episodeId/audio', (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  return res.sendStatus(204);
});

api.get('/studycast/:episodeId/audio', requireMediaAuth, async (req, res) => {
  const ep = store.studycast.find((e) => e.id === req.params.episodeId);
  if (!ep) return res.status(404).json({ detail: 'Episode not found' });
  try {
    const info = await ensureEpisodeAudio(ep.id);
    if (ep.duration_seconds !== info.duration_seconds || ep.duration_label !== info.duration_label) {
      ep.duration_seconds = info.duration_seconds;
      ep.duration_label = info.duration_label;
      saveStore();
    }
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.sendFile(info.filePath);
  } catch (err) {
    console.error(`[Studycast] Stream audio failed for ${ep.id}:`, err.message);
    const rawStatus = Number(err.status) || 500;
    const safeStatus = rawStatus >= 502 && rawStatus <= 504 ? 500 : rawStatus;
    return res.status(safeStatus).json({
      detail: err.message || 'Unable to stream episode audio',
      code: err.code || 'AUDIO_STREAM_FAILED',
      error: true,
    });
  }
});

api.post('/studycast/:episodeId/progress', requireAuth, (req, res) => {
  const currentTime = Number(req.body?.current_time) || 0;
  const duration = Number(req.body?.duration) || 0;
  const percentage = duration > 0 ? Math.min(100, Math.round((currentTime / duration) * 1000) / 10) : 0;

  const existing = store.studycast_progress.find(
    (p) => p.user_id === req.user.id && p.episode_id === req.params.episodeId
  );
  if (existing) {
    existing.current_time = currentTime;
    existing.duration = duration;
    existing.percentage = percentage;
    existing.updated_at = new Date().toISOString();
  } else {
    store.studycast_progress.push({
      user_id: req.user.id,
      episode_id: req.params.episodeId,
      current_time: currentTime,
      duration,
      percentage,
      updated_at: new Date().toISOString(),
    });
  }
  saveStore();
  return res.json({ message: 'Progress saved', percentage });
});

// --- PAYMENTS ---
function computePaymentSummary(invoices) {
  const todayStr = new Date().toISOString().split('T')[0];
  let total_billed = 0;
  let total_paid = 0;
  let outstanding_balance = 0;
  let paid_amount = 0;
  let partial_paid_amount = 0;
  let partial_balance = 0;
  let pending_balance = 0;
  let overdue_balance = 0;
  let paid_count = 0;
  let unpaid_count = 0;
  let partial_count = 0;
  let overdue_count = 0;

  for (const inv of invoices) {
    const total = roundCurrency(inv.total_amount || 0);
    const paid = roundCurrency(inv.amount_paid || 0);
    const balance = roundCurrency(
      inv.balance_due !== undefined ? inv.balance_due : Math.max(0, total - paid)
    );
    total_billed = roundCurrency(total_billed + total);
    total_paid = roundCurrency(total_paid + paid);
    outstanding_balance = roundCurrency(outstanding_balance + balance);

    if (inv.status === 'PAID') {
      paid_count += 1;
      paid_amount = roundCurrency(paid_amount + paid);
    } else if (inv.status === 'PARTIAL') {
      partial_count += 1;
      partial_paid_amount = roundCurrency(partial_paid_amount + paid);
      partial_balance = roundCurrency(partial_balance + balance);
    } else if (inv.status === 'OVERDUE') {
      overdue_count += 1;
      overdue_balance = roundCurrency(overdue_balance + balance);
    } else {
      unpaid_count += 1;
      pending_balance = roundCurrency(pending_balance + balance);
    }
  }

  const pending_invoices_count = unpaid_count + partial_count + overdue_count;
  const openInvoices = invoices.filter((inv) => roundCurrency(inv.balance_due ?? inv.total_amount - inv.amount_paid) > 0);
  const upcomingOpen = openInvoices
    .filter((inv) => inv.due_date >= todayStr)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  const overdueOpen = openInvoices
    .filter((inv) => inv.due_date < todayStr)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));

  const nextDue = upcomingOpen[0] || overdueOpen[0] || null;

  return {
    total_billed,
    total_paid,
    total_due: outstanding_balance,
    outstanding_balance,
    pending_invoices_count,
    paid_count,
    unpaid_count,
    partial_count,
    overdue_count,
    paid_amount,
    partial_paid_amount,
    partial_balance,
    pending_balance,
    overdue_balance,
    has_overdue: overdue_count > 0,
    next_due_date: nextDue ? nextDue.due_date : null,
    next_due_invoice: nextDue
      ? {
          id: nextDue.id,
          invoice_number: nextDue.invoice_number,
          category: nextDue.category,
          due_date: nextDue.due_date,
          balance_due: roundCurrency(nextDue.balance_due ?? nextDue.total_amount - nextDue.amount_paid),
          status: nextDue.status,
          is_overdue: nextDue.due_date < todayStr,
        }
      : null,
  };
}

function enrichInvoice(inv) {
  const total = roundCurrency(inv.total_amount || 0);
  const paid = roundCurrency(inv.amount_paid || 0);
  const balance = roundCurrency(inv.balance_due !== undefined ? inv.balance_due : Math.max(0, total - paid));
  const transactions = store.payment_transactions
    .filter((t) => t.invoice_id === inv.id)
    .sort((a, b) => b.paid_at.localeCompare(a.paid_at));
  return {
    ...inv,
    total_amount: total,
    amount_paid: paid,
    balance_due: balance,
    issue_date: inv.issue_date || toDateOnly(inv.created_at),
    academic_year: inv.academic_year || SCHOOL_IDENTITY.academic_year,
    transactions,
  };
}

function formatInrText(amount) {
  return `Rs. ${roundCurrency(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function drawSchoolLogoAndHeader(doc, documentTitle) {
  const startY = 42;
  // Geometric SchoolExpo Crest
  doc.save();
  doc.roundedRect(50, startY, 38, 38, 9).fill('#4f46e5');
  doc.polygon([69, startY + 9], [81, startY + 15], [69, startY + 21], [57, startY + 15]).fill('#ffffff');
  doc.rect(62, startY + 21, 14, 5).fill('#22d3ee');
  doc.restore();

  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(17).text(SCHOOL_IDENTITY.name, 98, startY + 1);
  doc.fillColor('#475569').font('Helvetica').fontSize(9).text(SCHOOL_IDENTITY.department, 98, startY + 21);
  doc.text(`${SCHOOL_IDENTITY.address} · GSTIN: ${SCHOOL_IDENTITY.gstin}`, 98, startY + 33);

  doc
    .fillColor('#4f46e5')
    .font('Helvetica-Bold')
    .fontSize(12)
    .text(documentTitle, 360, startY + 4, { width: 185, align: 'right' });
  doc
    .fillColor('#64748b')
    .font('Helvetica')
    .fontSize(8.5)
    .text(`Academic Year ${SCHOOL_IDENTITY.academic_year}`, 360, startY + 21, { width: 185, align: 'right' });

  doc.moveTo(50, startY + 52).lineTo(545, startY + 52).strokeColor('#cbd5e1').lineWidth(1).stroke();
  return startY + 66;
}

const VALID_DEMO_PAYMENT_METHODS = ['UPI', 'CARD', 'NET_BANKING'];

function sanitizePaymentMethodDetail(method, rawDetail) {
  const cleaned = String(rawDetail || '')
    .replace(/[<>\r\n]/g, '')
    .trim();
  if (method === 'UPI') {
    return (cleaned || 'student@demoupi').slice(0, 60);
  }
  if (method === 'CARD') {
    const digitsMatch = cleaned.match(/(\d{4})$/);
    const last4 = digitsMatch ? digitsMatch[1] : '4242';
    return `Demo Card •••• ${last4}`;
  }
  return (cleaned || 'Demo National Bank').slice(0, 48);
}

api.get('/payments/invoices', requireAuth, (req, res) => {
  const scoped = getBillingScopedInvoices(req.user);
  if (!scoped.allowed) {
    return res.status(403).json({ detail: 'Access denied to billing records' });
  }

  let invoices = scoped.invoices.map(enrichInvoice);
  invoices.sort((a, b) => a.due_date.localeCompare(b.due_date));

  const summary = computePaymentSummary(invoices);
  return res.json({
    school_identity: SCHOOL_IDENTITY,
    invoices,
    summary,
  });
});

api.get('/payments/transactions', requireAuth, (req, res) => {
  const scoped = getBillingScopedInvoices(req.user);
  if (!scoped.allowed) {
    return res.status(403).json({ detail: 'Access denied to payment history' });
  }

  const allowedInvoiceIds = new Set(scoped.invoices.map((i) => i.id));
  const filterInvoiceId = typeof req.query.invoice_id === 'string' ? req.query.invoice_id.trim() : '';

  let transactions = store.payment_transactions.filter((t) => allowedInvoiceIds.has(t.invoice_id));
  if (filterInvoiceId) {
    transactions = transactions.filter((t) => t.invoice_id === filterInvoiceId);
  }
  transactions.sort((a, b) => (b.paid_at || b.created_at).localeCompare(a.paid_at || a.created_at));

  return res.json({
    school_identity: SCHOOL_IDENTITY,
    transactions,
  });
});

api.get('/payments/invoices/:invoiceId', requireAuth, (req, res) => {
  const inv = store.invoices.find((i) => i.id === req.params.invoiceId);
  if (!inv) return res.status(404).json({ detail: 'Invoice not found' });
  if (!canAccessStudentBilling(req.user, inv.student_id)) {
    return res.status(403).json({ detail: 'Access denied to this invoice' });
  }
  return res.json({
    ...enrichInvoice(inv),
    school_identity: SCHOOL_IDENTITY,
  });
});

api.post('/payments/invoices/:invoiceId/pay', requireAuth, (req, res) => {
  const inv = store.invoices.find((i) => i.id === req.params.invoiceId);
  if (!inv) return res.status(404).json({ detail: 'Invoice not found' });
  if (!canAccessStudentBilling(req.user, inv.student_id)) {
    return res.status(403).json({ detail: 'You are not authorized to pay this invoice' });
  }

  const paymentMethod = String(req.body?.payment_method || '').toUpperCase().trim();
  if (!VALID_DEMO_PAYMENT_METHODS.includes(paymentMethod)) {
    return res.status(400).json({ detail: 'Select a valid demo payment method (UPI, CARD, or NET_BANKING)' });
  }

  const idempotencyKey = String(req.body?.idempotency_key || '').trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    return res.status(400).json({ detail: 'A valid payment idempotency key is required' });
  }

  // Idempotent replay protection
  const duplicateByKey = store.payment_transactions.find(
    (t) => t.invoice_id === inv.id && t.idempotency_key === idempotencyKey && t.status === 'SUCCESS'
  );
  if (duplicateByKey) {
    const scoped = getBillingScopedInvoices(req.user);
    return res.json({
      duplicate_prevented: true,
      message: 'This demo payment was already recorded.',
      invoice: enrichInvoice(inv),
      transaction: duplicateByKey,
      summary: computePaymentSummary(scoped.invoices.map(enrichInvoice)),
      school_identity: SCHOOL_IDENTITY,
    });
  }

  const total = roundCurrency(inv.total_amount || 0);
  const currentPaid = roundCurrency(inv.amount_paid || 0);
  const remaining = roundCurrency(Math.max(0, total - currentPaid));

  if (inv.status === 'PAID' || remaining <= 0) {
    return res.status(409).json({ detail: 'This invoice has already been paid in full.' });
  }

  const requestedAmount =
    req.body?.amount !== undefined && req.body?.amount !== null && req.body?.amount !== ''
      ? roundCurrency(Number(req.body.amount))
      : remaining;

  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    return res.status(400).json({ detail: 'Payment amount must be greater than zero.' });
  }
  if (requestedAmount > remaining) {
    return res.status(400).json({
      detail: `Payment amount cannot exceed remaining balance (${formatInrText(remaining)}).`,
    });
  }

  // Rapid accidental double-click guard (within 5 seconds for same invoice/amount/user)
  const nowMs = Date.now();
  const recentIdentical = store.payment_transactions.find(
    (t) =>
      t.invoice_id === inv.id &&
      t.paid_by_user_id === req.user.id &&
      t.amount === requestedAmount &&
      nowMs - new Date(t.paid_at || t.created_at).getTime() < 5000
  );
  if (recentIdentical) {
    return res.status(409).json({
      detail: 'A matching payment was just recorded moments ago. Please review your receipt history.',
    });
  }

  const nowIso = new Date().toISOString();
  const dateToken = toDateOnly(nowIso).replace(/-/g, '');
  const randomCode = crypto.randomBytes(3).toString('hex').toUpperCase();
  const seq = String(store.payment_transactions.length + 1).padStart(4, '0');

  inv.amount_paid = roundCurrency(currentPaid + requestedAmount);
  inv.balance_due = roundCurrency(Math.max(0, total - inv.amount_paid));
  inv.status = computeInvoiceStatus(inv, toDateOnly(nowIso));
  inv.paid_at = nowIso;

  const txn = {
    id: crypto.randomUUID(),
    invoice_id: inv.id,
    invoice_number: inv.invoice_number,
    invoice_category: inv.category,
    student_id: inv.student_id,
    student_name: inv.student_name,
    class_name: inv.class_name || '12 A',
    roll_number: inv.roll_number || 'N/A',
    paid_by_user_id: req.user.id,
    paid_by_name: req.user.name,
    paid_by_role: req.user.role,
    amount: requestedAmount,
    balance_after: inv.balance_due,
    invoice_status_after: inv.status,
    payment_method: paymentMethod,
    method_detail: sanitizePaymentMethodDetail(paymentMethod, req.body?.method_detail),
    status: 'SUCCESS',
    is_demo: true,
    mode: 'DEMO',
    demo_notice: 'Exhibition Demonstration — No real money charged',
    reference_number: `DEMO-TXN-${dateToken}-${randomCode}`,
    receipt_number: `RCPT-2026-${seq}-${randomCode.slice(0, 3)}`,
    idempotency_key: idempotencyKey,
    paid_at: nowIso,
    created_at: nowIso,
  };

  store.payment_transactions.push(txn);

  store.notifications.push({
    id: crypto.randomUUID(),
    user_id: inv.student_id,
    title: inv.status === 'PAID' ? 'Demo Fee Paid in Full' : 'Demo Partial Fee Recorded',
    message: `${formatInrText(requestedAmount)} recorded for ${inv.invoice_number} (${inv.category}). Receipt: ${txn.receipt_number}.`,
    type: 'payment',
    is_read: false,
    created_at: nowIso,
  });

  saveStore();

  const scoped = getBillingScopedInvoices(req.user);
  return res.json({
    duplicate_prevented: false,
    message: 'Demo payment confirmed. No real money was charged.',
    invoice: enrichInvoice(inv),
    transaction: txn,
    summary: computePaymentSummary(scoped.invoices.map(enrichInvoice)),
    school_identity: SCHOOL_IDENTITY,
  });
});

api.get('/payments/invoices/:invoiceId/pdf', requireAuth, (req, res) => {
  const inv = store.invoices.find((i) => i.id === req.params.invoiceId);
  if (!inv) return res.status(404).json({ detail: 'Invoice not found' });
  if (!canAccessStudentBilling(req.user, inv.student_id)) {
    return res.status(403).json({ detail: 'Access denied to this invoice PDF' });
  }

  const enriched = enrichInvoice(inv);
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  doc.on('end', () => {
    const pdfBuffer = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${inv.invoice_number}.pdf`);
    res.send(pdfBuffer);
  });

  let y = drawSchoolLogoAndHeader(doc, 'FEE INVOICE');

  // Metadata & Student Block
  doc.save();
  doc.roundedRect(50, y, 240, 88, 6).fill('#f8fafc').strokeColor('#e2e8f0').lineWidth(1).stroke();
  doc.roundedRect(305, y, 240, 88, 6).fill('#f8fafc').strokeColor('#e2e8f0').lineWidth(1).stroke();
  doc.restore();

  doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(8).text('BILLED TO STUDENT', 62, y + 10);
  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(11).text(enriched.student_name, 62, y + 24);
  doc.fillColor('#334155').font('Helvetica').fontSize(9.5);
  doc.text(`Class & Section: ${enriched.class_name || 'N/A'}`, 62, y + 42);
  doc.text(`Roll Number: ${enriched.roll_number || 'N/A'}`, 62, y + 56);
  doc.text(`Fee Category: ${enriched.category}`, 62, y + 70);

  doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(8).text('INVOICE DETAILS', 317, y + 10);
  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(11).text(enriched.invoice_number, 317, y + 24);
  doc.fillColor('#334155').font('Helvetica').fontSize(9.5);
  doc.text(`Issue Date: ${enriched.issue_date}`, 317, y + 42);
  doc.text(`Due Date: ${enriched.due_date}`, 317, y + 56);
  doc.font('Helvetica-Bold').text(`Status: ${enriched.status}`, 317, y + 70);

  y += 106;

  // Line Items Table Header
  doc.save();
  doc.rect(50, y, 495, 24).fill('#1e293b');
  doc.restore();
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5);
  doc.text('#', 58, y + 8, { width: 22 });
  doc.text('FEE DESCRIPTION', 82, y + 8, { width: 225 });
  doc.text('BASE FEE', 310, y + 8, { width: 75, align: 'right' });
  doc.text('GST', 390, y + 8, { width: 65, align: 'right' });
  doc.text('TOTAL', 460, y + 8, { width: 77, align: 'right' });
  y += 24;

  const items = Array.isArray(enriched.line_items) && enriched.line_items.length > 0
    ? enriched.line_items
    : [{ label: enriched.category, amount: enriched.subtotal, gst_amount: (enriched.cgst || 0) + (enriched.sgst || 0) }];

  items.forEach((item, idx) => {
    const gst = roundCurrency(item.gst_amount || 0);
    const base = roundCurrency(item.amount || 0);
    const lineTotal = roundCurrency(base + gst);
    if (idx % 2 === 1) {
      doc.save();
      doc.rect(50, y, 495, 24).fill('#f8fafc');
      doc.restore();
    }
    doc.fillColor('#0f172a').font('Helvetica').fontSize(9);
    doc.text(String(idx + 1), 58, y + 7, { width: 22 });
    doc.text(item.label, 82, y + 7, { width: 225 });
    doc.text(formatInrText(base), 310, y + 7, { width: 75, align: 'right' });
    doc.text(formatInrText(gst), 390, y + 7, { width: 65, align: 'right' });
    doc.font('Helvetica-Bold').text(formatInrText(lineTotal), 460, y + 7, { width: 77, align: 'right' });
    y += 24;
  });

  doc.moveTo(50, y).lineTo(545, y).strokeColor('#cbd5e1').lineWidth(0.8).stroke();
  y += 16;

  // Totals Summary Box
  doc.save();
  doc.roundedRect(305, y, 240, 120, 6).fill('#f8fafc').strokeColor('#cbd5e1').lineWidth(1).stroke();
  doc.restore();

  const summaryRows = [
    ['Subtotal', formatInrText(enriched.subtotal || 0), false],
    ['CGST', formatInrText(enriched.cgst || 0), false],
    ['SGST', formatInrText(enriched.sgst || 0), false],
    ['Total Invoice Amount', formatInrText(enriched.total_amount), true],
    ['Amount Paid', formatInrText(enriched.amount_paid), false],
  ];
  let sy = y + 10;
  summaryRows.forEach(([label, val, bold]) => {
    doc.fillColor('#334155').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
    doc.text(label, 318, sy, { width: 120 });
    doc.text(val, 430, sy, { width: 103, align: 'right' });
    sy += 17;
  });
  doc.moveTo(318, sy).lineTo(533, sy).strokeColor('#cbd5e1').lineWidth(0.8).stroke();
  sy += 7;
  doc.fillColor(enriched.balance_due > 0 ? '#be123c' : '#047857').font('Helvetica-Bold').fontSize(10.5);
  doc.text('Outstanding Balance', 318, sy, { width: 120 });
  doc.text(formatInrText(enriched.balance_due), 430, sy, { width: 103, align: 'right' });

  // Recorded Payments Note on left side
  if (enriched.transactions.length > 0) {
    doc.fillColor('#475569').font('Helvetica-Bold').fontSize(8.5).text('RECORDED PAYMENTS', 50, y + 4);
    let ty = y + 19;
    enriched.transactions.slice(0, 4).forEach((t) => {
      doc.fillColor('#334155').font('Helvetica').fontSize(8.5);
      doc.text(`${t.receipt_number} (${t.payment_method})`, 50, ty, { width: 235 });
      doc.text(`${toDateOnly(t.paid_at)} · ${formatInrText(t.amount)}`, 50, ty + 11, { width: 235 });
      ty += 25;
    });
  }

  // Footer
  doc.fillColor('#64748b').font('Helvetica').fontSize(8.5);
  doc.text(
    `${SCHOOL_IDENTITY.name} · ${SCHOOL_IDENTITY.email} · ${SCHOOL_IDENTITY.phone}`,
    50,
    748,
    { width: 495, align: 'center' }
  );
  doc.text(
    'The Oxford School Exhibition Demonstration Billing Statement — For academic demonstration use.',
    50,
    761,
    { width: 495, align: 'center' }
  );

  doc.end();
});

api.get('/payments/transactions/:transactionId/receipt/pdf', requireAuth, (req, res) => {
  const txn = store.payment_transactions.find((t) => t.id === req.params.transactionId);
  if (!txn) return res.status(404).json({ detail: 'Receipt transaction not found' });
  if (!canAccessStudentBilling(req.user, txn.student_id)) {
    return res.status(403).json({ detail: 'Access denied to this payment receipt' });
  }

  const inv = store.invoices.find((i) => i.id === txn.invoice_id);
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  doc.on('end', () => {
    const pdfBuffer = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${txn.receipt_number}.pdf`);
    res.send(pdfBuffer);
  });

  let y = drawSchoolLogoAndHeader(doc, 'PAYMENT RECEIPT');

  // Exhibition Demo Banner
  doc.save();
  doc.roundedRect(50, y, 495, 28, 6).fill('#eef2ff').strokeColor('#6366f1').lineWidth(1).stroke();
  doc.restore();
  doc
    .fillColor('#3730a3')
    .font('Helvetica-Bold')
    .fontSize(9.5)
    .text('EXHIBITION DEMONSTRATION RECEIPT — NO REAL MONEY CHARGED', 50, y + 9, {
      width: 495,
      align: 'center',
    });

  y += 42;

  // Receipt Summary Grid
  doc.save();
  doc.roundedRect(50, y, 495, 196, 8).fill('#f8fafc').strokeColor('#cbd5e1').lineWidth(1).stroke();
  doc.restore();

  const details = [
    ['Receipt Number', txn.receipt_number],
    ['Transaction Reference', txn.reference_number],
    ['Payment Status', 'SUCCESS (DEMO MODE)'],
    ['Payment Date & Time', new Date(txn.paid_at || txn.created_at).toLocaleString('en-IN')],
    ['Student Name', txn.student_name],
    ['Class & Roll Number', `${txn.class_name || 'N/A'} · Roll ${txn.roll_number || 'N/A'}`],
    ['Invoice Number', txn.invoice_number],
    ['Fee Category', txn.invoice_category],
    ['Demo Payment Method', `${txn.payment_method.replace('_', ' ')} (${txn.method_detail})`],
  ];

  let ry = y + 14;
  details.forEach(([label, value]) => {
    doc.fillColor('#64748b').font('Helvetica').fontSize(9.5).text(label, 68, ry, { width: 170 });
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(9.5).text(String(value), 245, ry, { width: 280 });
    ry += 20;
  });

  y += 214;

  // Financial Confirmation Box
  doc.save();
  doc.roundedRect(50, y, 495, 86, 8).fill('#ecfdf5').strokeColor('#10b981').lineWidth(1).stroke();
  doc.restore();

  doc.fillColor('#065f46').font('Helvetica-Bold').fontSize(10).text('DEMO AMOUNT PAID', 68, y + 14);
  doc.fillColor('#047857').font('Helvetica-Bold').fontSize(20).text(formatInrText(txn.amount), 68, y + 32);

  doc.fillColor('#065f46').font('Helvetica').fontSize(9.5);
  doc.text(`Total Invoice Amount: ${formatInrText(inv ? inv.total_amount : txn.amount + txn.balance_after)}`, 300, y + 18, {
    width: 225,
    align: 'right',
  });
  doc.font('Helvetica-Bold').text(
    `Remaining Invoice Balance: ${formatInrText(txn.balance_after)}`,
    300,
    y + 38,
    { width: 225, align: 'right' }
  );
  doc.font('Helvetica').text(`Invoice Status After Payment: ${txn.invoice_status_after}`, 300, y + 56, {
    width: 225,
    align: 'right',
  });

  doc.fillColor('#64748b').font('Helvetica').fontSize(8.5);
  doc.text(
    `${SCHOOL_IDENTITY.name} · ${SCHOOL_IDENTITY.email} · ${SCHOOL_IDENTITY.phone}`,
    50,
    748,
    { width: 495, align: 'center' }
  );
  doc.text(
    'This document is an automated The Oxford School exhibition demonstration receipt.',
    50,
    761,
    { width: 495, align: 'center' }
  );

  doc.end();
});

// --- CHAT ---
api.get('/chat/rooms', requireAuth, (req, res) => {
  const rooms = store.chat_rooms.map((room) => {
    const msgs = store.chat_messages
      .filter((m) => m.room_id === room.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const unread_count = store.chat_messages.filter(
      (m) => m.room_id === room.id && m.sender_id !== req.user.id && !(m.read_by || []).includes(req.user.id)
    ).length;
    return {
      ...room,
      last_message: msgs[0] || null,
      unread_count,
    };
  });
  return res.json(rooms);
});

api.get('/chat/rooms/:roomId/messages', requireAuth, (req, res) => {
  const skip = Number(req.query.skip) || 0;
  const limit = Number(req.query.limit) || 50;
  const msgs = store.chat_messages
    .filter((m) => m.room_id === req.params.roomId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  for (const m of msgs) {
    if (m.sender_id !== req.user.id && !(m.read_by || []).includes(req.user.id)) {
      m.read_by = [...(m.read_by || []), req.user.id];
    }
  }

  const sliced = msgs.slice(Math.max(0, msgs.length - skip - limit), msgs.length - skip);
  return res.json(sliced);
});

api.post('/chat/rooms/:roomId/messages', requireAuth, (req, res) => {
  const message = {
    id: crypto.randomUUID(),
    room_id: req.params.roomId,
    sender_id: req.user.id,
    sender_name: req.user.name,
    sender_avatar: req.user.avatar_url || null,
    content: req.body?.content || '',
    type: req.body?.type || 'TEXT',
    read_by: [req.user.id],
    created_at: new Date().toISOString(),
  };
  store.chat_messages.push(message);
  return res.json(message);
});

app.use('/api', api);

// Serve built React frontend
const buildDir = path.join(__dirname, 'frontend', 'build');
app.use(express.static(buildDir));

app.get('*', (_req, res) => {
  res.sendFile(path.join(buildDir, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`The Oxford School server running on http://${HOST}:${PORT}`);
  warmupPodcastCache().catch((err) => {
    console.warn('[Studycast] Podcast warmup skipped/failed:', err.message);
  });
});
