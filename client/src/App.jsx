import React, { useEffect, useState, useCallback, useRef } from 'react';

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
async function api(method, url, body, isForm) {
  const opts = {
    method,
    credentials: 'include',
    headers: {}
  };
  if (body && !isForm) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body && isForm) {
    opts.body = body;
  }
  const res = await fetch(url, opts);
  let data = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    data = await res.json().catch(() => null);
  }
  if (!res.ok) {
    const message = (data && data.error) || 'حدث خطأ غير متوقع';
    throw new Error(message);
  }
  return data;
}

const CURRENCIES = [
  'KWD', 'SAR', 'AED', 'QAR', 'BHD', 'OMR', 'USD', 'EUR', 'GBP',
  'EGP', 'JOD', 'IQD', 'LYD', 'MAD', 'TND', 'DZD', 'LBP', 'SYP'
];

function formatMoney(amount, currency) {
  const n = Number(amount || 0);
  return `${n.toLocaleString('ar', { maximumFractionDigits: 2 })} ${currency || ''}`.trim();
}

function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Theme handling
// ---------------------------------------------------------------------------
function applyTheme(theme) {
  let resolved = theme;
  if (theme === 'system' || !theme) {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = resolved;
}

function useThemeEffect(theme) {
  useEffect(() => {
    applyTheme(theme);
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => applyTheme('system');
      mq.addEventListener('change', listener);
      return () => mq.removeEventListener('change', listener);
    }
  }, [theme]);
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
function useToast() {
  const [toast, setToast] = useState(null);
  const timerRef = useRef(null);
  const show = useCallback((msg) => {
    setToast(msg);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setToast(null), 2800);
  }, []);
  return [toast, show];
}

// ---------------------------------------------------------------------------
// Full-size image viewer
// ---------------------------------------------------------------------------
function ImageViewer({ src, onClose }) {
  return (
    <div className="modal-overlay image-viewer-overlay">
      <div className="image-viewer-inner">
        <button type="button" className="modal-close-btn image-viewer-close" onClick={onClose}>×</button>
        <img src={src} alt="" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root App
// ---------------------------------------------------------------------------
export default function App() {
  const [booting, setBooting] = useState(true);
  const [authStatus, setAuthStatus] = useState(null); // { hasUsers, registrationOpen }
  const [user, setUser] = useState(null);
  const [settings, setSettings] = useState(null);
  const [nav, setNav] = useState([{ screen: 'projects' }]);
  const [toast, showToast] = useToast();
  const [showSignup, setShowSignup] = useState(false);

  useThemeEffect(settings ? settings.theme : 'system');

  const current = nav[nav.length - 1];

  const push = useCallback((screen, params) => {
    setNav((n) => {
      const next = [...n, { screen, params }];
      window.history.pushState({ depth: next.length }, '', '');
      return next;
    });
  }, []);
  const replace = useCallback((screen, params) => {
    window.history.replaceState({ depth: 1 }, '', '');
    setNav([{ screen, params }]);
  }, []);
  const back = useCallback(() => {
    window.history.back();
  }, []);

  // establish a baseline history entry so the first hardware/gesture back
  // press only pops one internal screen instead of leaving the app
  useEffect(() => {
    window.history.replaceState({ depth: 1 }, '', '');
  }, []);

  // intercept the device/browser back button so it navigates within the
  // app's own screen stack instead of exiting the app
  useEffect(() => {
    const onPopState = () => {
      setNav((n) => (n.length > 1 ? n.slice(0, -1) : n));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const loadMe = useCallback(async () => {
    try {
      const data = await api('GET', '/api/auth/me');
      setUser(data.user);
      setSettings(data.settings);
      return data;
    } catch (e) {
      setUser(null);
      setSettings(null);
      return null;
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const status = await api('GET', '/api/auth/status');
        setAuthStatus(status);
        if (status.hasUsers) {
          await loadMe();
        }
      } catch (e) {
        showToast(e.message);
      } finally {
        setBooting(false);
      }
    })();
  }, [loadMe, showToast]);

  const handleAuthed = useCallback((data) => {
    setUser(data.user);
    if (data.settings) setSettings(data.settings);
    setAuthStatus((s) => ({ ...(s || {}), hasUsers: true }));
    replace('projects');
  }, [replace]);

  const handleLogout = useCallback(async () => {
    try {
      await api('POST', '/api/auth/logout');
    } catch (e) {
      /* ignore */
    }
    setUser(null);
    setSettings(null);
    replace('projects');
  }, [replace]);

  const refreshSettings = useCallback(async () => {
    try {
      const data = await api('GET', '/api/settings');
      setSettings(data.settings);
    } catch (e) {
      /* ignore */
    }
  }, []);

  if (booting) {
    return (
      <div className="spinner-wrap">
        <div className="muted">جارِ التحميل...</div>
      </div>
    );
  }

  if (!user) {
    if (authStatus && !authStatus.hasUsers) {
      return <SetupScreen isFirstUser onDone={handleAuthed} showToast={showToast} />;
    }
    if (showSignup) {
      return (
        <SetupScreen
          onDone={handleAuthed}
          onCancel={() => setShowSignup(false)}
          showToast={showToast}
        />
      );
    }
    return (
      <LoginScreen
        registrationOpen={authStatus ? authStatus.registrationOpen : false}
        onLogin={handleAuthed}
        onGoSetup={() => setShowSignup(true)}
        showToast={showToast}
      />
    );
  }

  const ctx = { user, settings, push, replace, back, showToast, refreshSettings, onLogout: handleLogout };

  return (
    <div className="app-shell">
      {current.screen === 'projects' && <ProjectsScreen ctx={ctx} />}
      {current.screen === 'project-home' && <ProjectHomeScreen ctx={ctx} params={current.params} />}
      {current.screen === 'category' && <CategoryScreen ctx={ctx} params={current.params} />}
      {current.screen === 'item' && <ItemScreen ctx={ctx} params={current.params} />}
      {current.screen === 'settings' && <SettingsScreen ctx={ctx} />}
      {current.screen === 'users-admin' && <UsersAdminScreen ctx={ctx} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Login Screen
// ---------------------------------------------------------------------------
function LoginScreen({ registrationOpen, onLogin, onGoSetup, showToast }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api('POST', '/api/auth/login', { username, password, remember });
      onLogin(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="card auth-card">
        <div className="auth-title">عَمار</div>
        <div className="auth-subtitle">تسجيل الدخول لإدارة مشاريعك</div>
        {error && <div className="error-text">{error}</div>}
        <form onSubmit={submit}>
          <div className="field">
            <label>اسم المستخدم</label>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div className="field">
            <label>كلمة المرور</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <div className="checkbox-row">
            <input
              type="checkbox"
              id="remember"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <label htmlFor="remember">تذكرني / ابقني مسجلاً</label>
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
            دخول
          </button>
        </form>
        {registrationOpen && (
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button className="link-btn" onClick={onGoSetup}>
              إنشاء حساب جديد
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup Screen (first user)
// ---------------------------------------------------------------------------
function SetupScreen({ isFirstUser, onDone, onCancel, showToast }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 6) {
      setError('كلمة المرور يجب أن تكون 6 أحرف على الأقل');
      return;
    }
    if (password !== confirm) {
      setError('كلمتا المرور غير متطابقتين');
      return;
    }
    setLoading(true);
    try {
      const data = await api('POST', '/api/auth/setup', { username, password, display_name: displayName });
      onDone(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="card auth-card">
        <div className="auth-title">عَمار</div>
        <div className="auth-subtitle">
          {isFirstUser ? 'إنشاء الحساب الأول — هذا الحساب سيكون الأدمن' : 'إنشاء حساب جديد'}
        </div>
        {error && <div className="error-text">{error}</div>}
        <form onSubmit={submit}>
          <div className="field">
            <label>اسم المستخدم</label>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div className="field">
            <label>الاسم الظاهر</label>
            <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="field">
            <label>كلمة المرور</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <div className="field">
            <label>تأكيد كلمة المرور</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
            إنشاء الحساب
          </button>
        </form>
        {!isFirstUser && (
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button className="link-btn" onClick={onCancel}>لديك حساب؟ سجّل الدخول</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Projects Screen
// ---------------------------------------------------------------------------
function ProjectsScreen({ ctx }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('GET', '/api/projects');
      setProjects(data.projects);
    } catch (e) {
      ctx.showToast(e.message);
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="topbar">
        <h1>عَمار — مشاريعي</h1>
        <button className="icon-btn" onClick={() => ctx.push('settings')}>⚙</button>
        <button className="btn btn-primary fab-top-right" onClick={() => setShowNew(true)}>
          ＋ مشروع جديد
        </button>
      </div>
      <div className="container">
        {loading && <div className="spinner-wrap muted">جارِ التحميل...</div>}
        {!loading && projects.length === 0 && (
          <div className="empty-state">لا توجد مشاريع بعد. أضف مشروعك الأول.</div>
        )}
        {projects.map((p) => (
          <div key={p.id} className="card project-card" onClick={() => ctx.push('project-home', { id: p.id })}>
            <div className="row-between">
              <div>
                <div className="card-title">{p.name}</div>
                {p.description && <div className="muted" style={{ fontSize: 14 }}>{p.description}</div>}
              </div>
              {!!p.archived && <span className="badge badge-muted">مؤرشف</span>}
            </div>
            <div className="stat-line">
              <span>إجمالي المشروع</span>
              <span>{formatMoney(p.paid, p.currency)}</span>
            </div>
            <div className="stat-line">
              <span>عدد البنود</span>
              <span>{p.item_count}</span>
            </div>
            <div className="stat-line">
              <span>تاريخ الإنشاء</span>
              <span>{new Date(p.created_at).toLocaleDateString('ar')}</span>
            </div>
          </div>
        ))}
      </div>
      {showNew && (
        <NewProjectModal
          defaultCurrency={ctx.settings ? ctx.settings.currency : 'KWD'}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            load();
          }}
          showToast={ctx.showToast}
        />
      )}
    </div>
  );
}

function NewProjectModal({ defaultCurrency, onClose, onCreated, showToast }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency || 'KWD');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    try {
      await api('POST', '/api/projects', { name, description, currency });
      onCreated();
    } catch (e) {
      showToast(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header-row">
          <div className="modal-title">مشروع جديد</div>
          <button type="button" className="modal-close-btn" onClick={onClose}>×</button>
        </div>
        <form onSubmit={submit}>
          <div className="field">
            <label>اسم المشروع</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
          </div>
          <div className="field">
            <label>الوصف (اختياري)</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="field">
            <label>عملة المشروع</label>
            <Dropdown value={currency} options={CURRENCIES} onChange={setCurrency} />
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
            حفظ
          </button>
        </form>
      </div>
    </div>
  );
}

function EditProjectModal({ project, onClose, onSaved, onDeleted, showToast }) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description || '');
  const [currency, setCurrency] = useState(project.currency || 'KWD');
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api('PATCH', `/api/projects/${project.id}`, { name, description, currency });
      onSaved();
    } catch (e) {
      showToast(e.message);
    } finally {
      setLoading(false);
    }
  };

  const remove = async () => {
    setLoading(true);
    try {
      await api('DELETE', `/api/projects/${project.id}`);
      onDeleted();
    } catch (e) {
      showToast(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header-row">
          <div className="modal-title">تعديل المشروع</div>
          <button type="button" className="modal-close-btn" onClick={onClose}>×</button>
        </div>
        <form onSubmit={submit}>
          <div className="field">
            <label>اسم المشروع</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field">
            <label>الوصف (اختياري)</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="field">
            <label>عملة المشروع</label>
            <Dropdown value={currency} options={CURRENCIES} onChange={setCurrency} />
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={loading}>حفظ</button>
        </form>
        {!confirmDelete ? (
          <button className="btn btn-danger btn-block" style={{ marginTop: 10 }} onClick={() => setConfirmDelete(true)}>
            حذف المشروع
          </button>
        ) : (
          <div style={{ marginTop: 10 }}>
            <div className="error-text">سيتم حذف المشروع وكل أقسامه وبنوده ودفعاته وصوره نهائيًا. هل أنت متأكد؟</div>
            <button className="btn btn-danger btn-block" onClick={remove} disabled={loading}>تأكيد الحذف</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Project Home Screen
// ---------------------------------------------------------------------------
async function downloadBlob(url, filename) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('تعذر التنزيل');
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function buildPrintHtml(project, categories, rawCurrency) {
  // Defense in depth: the server now validates currency against a fixed
  // whitelist, but escape it here too in case any pre-existing record
  // still holds an unexpected value — this string is injected into raw
  // HTML below, unlike the rest of the app where JSX escapes it for us.
  const currency = escapeHtml(rawCurrency);
  // Only report on items that actually have payment activity — an item with
  // nothing paid yet adds no useful information to a payments report.
  const visibleCategories = categories
    .map((cat) => ({ ...cat, items: cat.items.filter((it) => it.paid > 0) }))
    .filter((cat) => cat.items.length > 0);

  const itemBlock = (it) => `
    <div class="item-block">
      <div class="item-title">${escapeHtml(it.name)}</div>
      <div class="item-stats">
        ${it.has_agreed ? `<span>المتفق عليه: <b>${formatMoney(it.agreed, currency)}</b></span>` : ''}
        <span>المدفوع: <b>${formatMoney(it.paid, currency)}</b></span>
        ${it.has_agreed ? `<span>المتبقي: <b>${formatMoney(it.remaining, currency)}</b></span>` : ''}
      </div>
      ${
        it.payments && it.payments.length
          ? `<table class="payments">
              <tr>
                <th>اسم الدفعة</th>
                <th>التاريخ</th>
                <th>ملاحظة</th>
                <th>المبلغ</th>
              </tr>
              ${it.payments
                .map(
                  (p) => `<tr>
                    <td>${escapeHtml(p.name)}</td>
                    <td>${escapeHtml(p.date)}</td>
                    <td>${escapeHtml(p.note || '')}</td>
                    <td>${formatMoney(p.amount, currency)}</td>
                  </tr>`
                )
                .join('')}
            </table>`
          : ''
      }
    </div>`;

  const catBlocks = visibleCategories
    .map(
      (cat) => `
      <div class="category-block">
        <div class="category-header">
          <span class="name">${escapeHtml(cat.name)}</span>
          <span class="total">${formatMoney(cat.total, currency)}</span>
        </div>
        ${cat.items.map(itemBlock).join('')}
      </div>`
    )
    .join('');

  const total = visibleCategories.reduce((s, c) => s + c.total, 0);
  const today = new Date().toLocaleDateString('ar');

  return `<!doctype html>
  <html lang="ar" dir="rtl"><head><meta charset="utf-8" />
  <title>${escapeHtml(project.name)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: Tahoma, 'Segoe UI', sans-serif; padding: 36px; color: #16202e; background: #fff; }
    .doc-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #0b63d6; padding-bottom: 14px; margin-bottom: 22px; }
    .doc-header .brand { font-size: 20px; font-weight: 800; color: #0b63d6; }
    .doc-header .date { font-size: 12px; color: #888; }
    .project-title { font-size: 24px; font-weight: 800; margin: 0 0 4px; }
    .project-desc { font-size: 13px; color: #666; margin-bottom: 18px; }
    .total-card { background: #0b63d6; color: #fff; border-radius: 14px; padding: 18px 22px; margin-bottom: 26px; display: flex; justify-content: space-between; align-items: center; }
    .total-card .label { font-size: 13px; opacity: .9; }
    .total-card .value { font-size: 26px; font-weight: 800; }
    .category-block { margin-bottom: 22px; page-break-inside: avoid; }
    .category-header { display: flex; justify-content: space-between; align-items: center; background: #f2f4f7; border-right: 4px solid #c98a3a; padding: 9px 14px; border-radius: 8px; margin-bottom: 12px; }
    .category-header .name { font-weight: 700; color: #c98a3a; font-size: 14.5px; }
    .category-header .total { font-weight: 800; font-size: 14.5px; }
    .item-block { margin-bottom: 16px; padding-right: 6px; }
    .item-title { font-weight: 700; font-size: 14px; margin-bottom: 4px; }
    .item-stats { display: flex; gap: 16px; font-size: 12px; color: #666; margin-bottom: 8px; }
    .item-stats b { color: #16202e; }
    table.payments { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-bottom: 6px; }
    table.payments th { background: #0b63d6; color: #fff; padding: 7px 8px; text-align: right; font-weight: 600; }
    table.payments td { padding: 6px 8px; border-bottom: 1px solid #eee; }
    table.payments tr:nth-child(even) td { background: #f8f9fb; }
    .empty-note { color: #999; font-size: 13px; text-align: center; padding: 30px 0; }
    .doc-footer { text-align: center; color: #aaa; font-size: 11px; margin-top: 32px; border-top: 1px solid #eee; padding-top: 12px; }
    @media print {
      .total-card, .category-header, table.payments th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
  </head><body>
    <div class="doc-header">
      <span class="brand">عَمار</span>
      <span class="date">تاريخ التقرير: ${today}</span>
    </div>
    <div class="project-title">${escapeHtml(project.name)}</div>
    ${project.description ? `<div class="project-desc">${escapeHtml(project.description)}</div>` : ''}
    <div class="total-card">
      <span class="label">إجمالي المدفوعات</span>
      <span class="value">${formatMoney(total, currency)}</span>
    </div>
    ${catBlocks || '<div class="empty-note">لا توجد مدفوعات مسجّلة بعد بهذا المشروع.</div>'}
    <div class="doc-footer">تم إنشاء هذا التقرير بواسطة عَمار</div>
  </body></html>`;
}

function ProjectHomeScreen({ ctx, params }) {
  const [project, setProject] = useState(null);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [showEditProject, setShowEditProject] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('GET', `/api/projects/${params.id}/summary`);
      setProject(data.project);
      setCategories(data.categories);
    } catch (e) {
      ctx.showToast(e.message);
      ctx.back();
    } finally {
      setLoading(false);
    }
  }, [ctx, params.id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || !project) {
    return <div className="spinner-wrap muted">جارِ التحميل...</div>;
  }

  const currency = project.currency;
  const total = categories.reduce((s, c) => s + c.total, 0);

  const exportPdf = async () => {
    try {
      const data = await api('GET', `/api/projects/${params.id}/summary`);
      const html = buildPrintHtml(data.project, data.categories, data.project.currency);
      const win = window.open('', '_blank');
      if (win) win.opener = null; // defense in depth: sever the opener link
      win.document.write(html);
      win.document.close();
      setTimeout(() => win.print(), 300);
    } catch (e) {
      ctx.showToast(e.message);
    }
  };

  const exportCsv = async () => {
    try {
      await downloadBlob(`/api/projects/${params.id}/export/csv?scope=all`, `${project.name}-export.csv`);
    } catch (e) {
      ctx.showToast(e.message);
    }
  };

  return (
    <div>
      <div className="topbar">
        <button className="icon-btn" onClick={ctx.back}>→</button>
        <button className="icon-btn" onClick={() => setShowEditProject(true)}>✎</button>
        <div className="topbar-title-block">
          <h2>{project.name}</h2>
          {project.description && <div className="topbar-subtitle">{project.description}</div>}
        </div>
        <button className="btn btn-primary fab-top-right" onClick={() => setShowNewCategory(true)}>＋ قسم جديد</button>
      </div>
      <div className="container">
        <div className="ring-wrap">
          <div className="ring-value">{formatMoney(total, currency)}</div>
          <div className="ring-label">إجمالي المدفوعات</div>
        </div>
        <div className="grid-2">
          {categories.map((cat) => (
            <div key={cat.id} className="category-card" onClick={() => ctx.push('category', { id: cat.id, projectId: project.id })}>
              <div className="cat-name">{cat.name}</div>
              <div className="cat-total">{formatMoney(cat.total, currency)}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={exportPdf}>🖨 تنزيل PDF</button>
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={exportCsv}>📊 تصدير Excel</button>
        </div>
      </div>
      {showEditProject && (
        <EditProjectModal
          project={project}
          onClose={() => setShowEditProject(false)}
          onSaved={() => {
            setShowEditProject(false);
            load();
          }}
          onDeleted={() => {
            setShowEditProject(false);
            ctx.back();
          }}
          showToast={ctx.showToast}
        />
      )}
      {showNewCategory && (
        <NewCategoryModal
          projectId={project.id}
          onClose={() => setShowNewCategory(false)}
          onCreated={() => {
            setShowNewCategory(false);
            load();
          }}
          showToast={ctx.showToast}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category Screen
// ---------------------------------------------------------------------------
function CategoryScreen({ ctx, params }) {
  const [category, setCategory] = useState(null);
  const [currency, setCurrency] = useState('');
  const [loading, setLoading] = useState(true);
  const [showEditCategory, setShowEditCategory] = useState(false);
  const [showNewItem, setShowNewItem] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('GET', `/api/projects/${params.projectId}/summary`);
      const cat = data.categories.find((c) => c.id === params.id);
      setCategory(cat || null);
      setCurrency(data.project.currency);
    } catch (e) {
      ctx.showToast(e.message);
      ctx.back();
    } finally {
      setLoading(false);
    }
  }, [ctx, params.id, params.projectId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || !category) {
    return <div className="spinner-wrap muted">جارِ التحميل...</div>;
  }

  return (
    <div>
      <div className="topbar">
        <button className="icon-btn" onClick={ctx.back}>→</button>
        <button className="icon-btn" onClick={() => setShowEditCategory(true)}>✎</button>
        <h2>{category.name}</h2>
        <button className="btn btn-primary fab-top-right" onClick={() => setShowNewItem(true)}>＋ إضافة بند</button>
      </div>
      <div className="container">
        <div className="card">
          <div className="row-between">
            <span className="muted">إجمالي القسم</span>
            <span style={{ fontWeight: 800, fontSize: 18 }}>{formatMoney(category.total, currency)}</span>
          </div>
          <div className="stat-line">
            <span>عدد البنود</span>
            <span>{category.items.length}</span>
          </div>
        </div>
        {category.items.length === 0 && <div className="empty-state">لا توجد بنود في هذا القسم بعد.</div>}
        {category.items.map((it) => (
          <div
            key={it.id}
            className="list-item"
            onClick={() => ctx.push('item', { id: it.id, categoryId: category.id, projectId: params.projectId })}
          >
            <span>{it.name}</span>
            <span style={{ fontWeight: 700 }}>{formatMoney(it.paid, currency)}</span>
          </div>
        ))}
      </div>

      {showEditCategory && (
        <EditCategoryModal
          category={category}
          onClose={() => setShowEditCategory(false)}
          onSaved={() => {
            setShowEditCategory(false);
            load();
          }}
          onDeleted={() => {
            setShowEditCategory(false);
            ctx.back();
          }}
          showToast={ctx.showToast}
        />
      )}

      {showNewItem && (
        <NewItemModal
          categoryId={category.id}
          onClose={() => setShowNewItem(false)}
          onCreated={() => {
            setShowNewItem(false);
            load();
          }}
          showToast={ctx.showToast}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item Screen
// ---------------------------------------------------------------------------
function ItemScreen({ ctx, params }) {
  const [item, setItem] = useState(null);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showPaymentModal, setShowPaymentModal] = useState(null); // null | 'new' | payment object
  const [showEditItem, setShowEditItem] = useState(false);
  const [viewImage, setViewImage] = useState(null);
  const currency = item ? item.currency : '';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('GET', `/api/items/${params.id}`);
      setItem(data.item);
      setPayments(data.payments);
    } catch (e) {
      ctx.showToast(e.message);
      ctx.back();
    } finally {
      setLoading(false);
    }
  }, [ctx, params.id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || !item) {
    return <div className="spinner-wrap muted">جارِ التحميل...</div>;
  }

  return (
    <div>
      <div className="topbar">
        <button className="icon-btn" onClick={ctx.back}>→</button>
        <button className="icon-btn" onClick={() => setShowEditItem(true)}>✎</button>
        <h2>{item.name}</h2>
        <button className="btn btn-primary fab-top-right" onClick={() => setShowPaymentModal('new')}>＋ إنشاء دفعة</button>
      </div>
      <div className="container">
        {item.has_agreed ? (
          <div className="summary-row">
            <div className="summary-cell">
              <div className="label">المتفق عليه</div>
              <div className="value">{formatMoney(item.agreed, currency)}</div>
            </div>
            <div className="summary-cell">
              <div className="label">المدفوع</div>
              <div className="value">{formatMoney(item.paid, currency)}</div>
            </div>
            <div className="summary-cell">
              <div className="label">المتبقي</div>
              <div className={`value ${item.remaining > 0 ? 'value-red' : 'value-green'}`}>
                {formatMoney(item.remaining, currency)}
              </div>
            </div>
          </div>
        ) : (
          <div className="summary-row" style={{ gridTemplateColumns: '1fr' }}>
            <div className="summary-cell">
              <div className="label">المدفوع</div>
              <div className="value">{formatMoney(item.paid, currency)}</div>
            </div>
          </div>
        )}

        <div className="section-title">الدفعات ({payments.length})</div>
        {payments.length === 0 && <div className="empty-state">لا توجد دفعات بعد.</div>}
        {payments.map((p) => (
          <div key={p.id} className="payment-card" onClick={() => setShowPaymentModal(p)}>
            <div className="row-between">
              <span style={{ fontWeight: 700 }}>{p.name}</span>
              <span style={{ fontWeight: 700 }}>{formatMoney(p.amount, currency)}</span>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>{p.date}</div>
            {p.note && <div className="muted" style={{ fontSize: 13 }}>{p.note}</div>}
            {p.images && p.images.length > 0 && (
              <div className="thumb-row">
                {p.images.map((img) => (
                  <img
                    key={img.id}
                    className="thumb"
                    src={`/api/uploads/${img.id}`}
                    alt=""
                    onClick={(e) => {
                      e.stopPropagation();
                      setViewImage(`/api/uploads/${img.id}`);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {viewImage && <ImageViewer src={viewImage} onClose={() => setViewImage(null)} />}

      {showPaymentModal && (
        <PaymentModal
          itemId={item.id}
          payment={showPaymentModal === 'new' ? null : showPaymentModal}
          onClose={() => setShowPaymentModal(null)}
          onSaved={() => {
            setShowPaymentModal(null);
            load();
          }}
          showToast={ctx.showToast}
        />
      )}

      {showEditItem && (
        <EditItemModal
          item={item}
          onClose={() => setShowEditItem(false)}
          onSaved={() => {
            setShowEditItem(false);
            load();
          }}
          onDeleted={() => {
            setShowEditItem(false);
            ctx.back();
          }}
          showToast={ctx.showToast}
        />
      )}
    </div>
  );
}

function EditItemModal({ item, onClose, onSaved, onDeleted, showToast }) {
  const [name, setName] = useState(item.name);
  const [hasAgreed, setHasAgreed] = useState(item.has_agreed !== false);
  const [agreed, setAgreed] = useState(String(item.agreed || 0));
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api('PATCH', `/api/items/${item.id}`, {
        name,
        has_agreed: hasAgreed,
        agreed: hasAgreed ? parseFloat(agreed) || 0 : 0
      });
      onSaved();
    } catch (e) {
      showToast(e.message);
    } finally {
      setLoading(false);
    }
  };

  const remove = async () => {
    setLoading(true);
    try {
      await api('DELETE', `/api/items/${item.id}`);
      onDeleted();
    } catch (e) {
      showToast(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header-row">
          <div className="modal-title">تعديل البند</div>
          <button type="button" className="modal-close-btn" onClick={onClose}>×</button>
        </div>
        <form onSubmit={submit}>
          <div className="field">
            <label>اسم البند</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="settings-row" style={{ marginBottom: 14 }}>
            <span>تفعيل المبلغ المتفق عليه لهذا البند</span>
            <Switch on={hasAgreed} onToggle={() => setHasAgreed((v) => !v)} />
          </div>
          {hasAgreed && (
            <div className="field">
              <label>المتفق عليه</label>
              <input type="number" step="0.01" value={agreed} onChange={(e) => setAgreed(e.target.value)} />
            </div>
          )}
          <button className="btn btn-primary btn-block" type="submit" disabled={loading}>حفظ</button>
        </form>
        {!confirmDelete ? (
          <button className="btn btn-danger btn-block" style={{ marginTop: 10 }} onClick={() => setConfirmDelete(true)}>
            حذف البند
          </button>
        ) : (
          <div style={{ marginTop: 10 }}>
            <div className="error-text">سيتم حذف البند وكل دفعاته وصوره نهائيًا. هل أنت متأكد؟</div>
            <button className="btn btn-danger btn-block" onClick={remove} disabled={loading}>تأكيد الحذف</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payment Modal
// ---------------------------------------------------------------------------
function PaymentModal({ itemId, payment, onClose, onSaved, showToast }) {
  const [name, setName] = useState(payment ? payment.name : '');
  const [amount, setAmount] = useState(payment ? String(payment.amount) : '');
  const [date, setDate] = useState(payment ? payment.date : todayStr());
  const [note, setNote] = useState(payment ? payment.note || '' : '');
  const [images, setImages] = useState(payment ? payment.images || [] : []); // already-uploaded images (edit mode)
  const [pendingFiles, setPendingFiles] = useState([]); // { localId, file, previewUrl } — queued before first save
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [viewSrc, setViewSrc] = useState(null);
  const cameraRef = useRef(null);
  const galleryRef = useRef(null);

  useEffect(() => {
    // revoke object URLs on unmount to avoid memory leaks
    return () => {
      pendingFiles.forEach((pf) => URL.revokeObjectURL(pf.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickFiles = (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    if (payment) {
      // editing an existing payment: upload immediately
      uploadFiles(files);
    } else {
      // creating a new payment: queue locally, upload happens on save
      const queued = files.map((file) => ({
        localId: `${Date.now()}-${Math.random()}`,
        file,
        previewUrl: URL.createObjectURL(file)
      }));
      setPendingFiles((prev) => [...prev, ...queued]);
    }
  };

  const uploadFiles = async (files) => {
    if (!payment || !files || files.length === 0) return;
    const form = new FormData();
    for (const f of files) form.append('files', f);
    setLoading(true);
    try {
      const data = await api('POST', `/api/payments/${payment.id}/images`, form, true);
      setImages((prev) => [...prev, ...data.images]);
    } catch (e) {
      showToast(e.message);
    } finally {
      setLoading(false);
    }
  };

  const removeImage = async (imgId) => {
    try {
      await api('DELETE', `/api/images/${imgId}`);
      setImages((prev) => prev.filter((i) => i.id !== imgId));
    } catch (e) {
      showToast(e.message);
    }
  };

  const removePending = (localId) => {
    setPendingFiles((prev) => {
      const target = prev.find((pf) => pf.localId === localId);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((pf) => pf.localId !== localId);
    });
  };

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (!payment) {
        const data = await api('POST', '/api/payments', { item_id: itemId, name, amount: parseFloat(amount) || 0, date, note });
        const newId = data.payment.id;
        if (pendingFiles.length > 0) {
          const form = new FormData();
          pendingFiles.forEach((pf) => form.append('files', pf.file));
          await api('POST', `/api/payments/${newId}/images`, form, true);
          pendingFiles.forEach((pf) => URL.revokeObjectURL(pf.previewUrl));
        }
      } else {
        await api('PATCH', `/api/payments/${payment.id}`, { name, amount: parseFloat(amount) || 0, date, note });
      }
      onSaved();
    } catch (e) {
      showToast(e.message);
    } finally {
      setLoading(false);
    }
  };

  const remove = async () => {
    setLoading(true);
    try {
      await api('DELETE', `/api/payments/${payment.id}`);
      onSaved();
    } catch (e) {
      showToast(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header-row">
          <div className="modal-title">{payment ? 'تعديل الدفعة' : 'دفعة جديدة'}</div>
          <button type="button" className="modal-close-btn" onClick={onClose}>×</button>
        </div>
        <form onSubmit={submit}>
          <div className="field">
            <label>اسم الدفعة</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field">
            <label>المبلغ</label>
            <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </div>
          <div className="field">
            <label>التاريخ</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </div>
          <div className="field">
            <label>ملاحظة (اختياري)</label>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </div>

          <div className="field">
            <label>صور الفاتورة</label>
            <div className="image-pick-row">
              <button type="button" className="btn btn-secondary" onClick={() => cameraRef.current.click()}>
                📷 كاميرا
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => galleryRef.current.click()}>
                🖼 من الاستديو
              </button>
            </div>
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                pickFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <input
              ref={galleryRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                pickFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <div className="image-preview-grid">
              {images.map((img) => (
                <div key={img.id} className="image-preview-item">
                  <img src={`/api/uploads/${img.id}`} alt="" onClick={() => setViewSrc(`/api/uploads/${img.id}`)} />
                  <button type="button" className="remove-btn" onClick={() => removeImage(img.id)}>×</button>
                </div>
              ))}
              {pendingFiles.map((pf) => (
                <div key={pf.localId} className="image-preview-item">
                  <img src={pf.previewUrl} alt="" onClick={() => setViewSrc(pf.previewUrl)} />
                  <button type="button" className="remove-btn" onClick={() => removePending(pf.localId)}>×</button>
                </div>
              ))}
            </div>
          </div>

          <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
            {payment ? 'حفظ التعديلات' : 'حفظ'}
          </button>
        </form>

        {payment && (
          !confirmDelete ? (
            <button className="btn btn-danger btn-block" style={{ marginTop: 10 }} onClick={() => setConfirmDelete(true)}>
              حذف الدفعة
            </button>
          ) : (
            <div style={{ marginTop: 10 }}>
              <div className="error-text">سيتم حذف الدفعة وصورها نهائيًا. هل أنت متأكد؟</div>
              <button className="btn btn-danger btn-block" onClick={remove} disabled={loading}>تأكيد الحذف</button>
            </div>
          )
        )}
      </div>
      {viewSrc && <ImageViewer src={viewSrc} onClose={() => setViewSrc(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category & Item modals (used from Project Home / Category screens)
// ---------------------------------------------------------------------------
function NewCategoryModal({ projectId, onClose, onCreated, showToast }) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api('POST', `/api/projects/${projectId}/categories`, { name });
      onCreated();
    } catch (e) {
      showToast(e.message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="modal-overlay">
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header-row">
          <div className="modal-title">قسم جديد</div>
          <button type="button" className="modal-close-btn" onClick={onClose}>×</button>
        </div>
        <form onSubmit={submit}>
          <div className="field">
            <label>اسم القسم</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={loading}>حفظ</button>
        </form>
      </div>
    </div>
  );
}

function EditCategoryModal({ category, onClose, onSaved, onDeleted, showToast }) {
  const [name, setName] = useState(category.name);
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api('PATCH', `/api/categories/${category.id}`, { name });
      onSaved();
    } catch (e) {
      showToast(e.message);
    } finally {
      setLoading(false);
    }
  };

  const remove = async () => {
    setLoading(true);
    try {
      await api('DELETE', `/api/categories/${category.id}`);
      onDeleted();
    } catch (e) {
      showToast(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header-row">
          <div className="modal-title">تعديل القسم</div>
          <button type="button" className="modal-close-btn" onClick={onClose}>×</button>
        </div>
        <form onSubmit={submit}>
          <div className="field">
            <label>اسم القسم</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={loading}>حفظ</button>
        </form>
        {!confirmDelete ? (
          <button className="btn btn-danger btn-block" style={{ marginTop: 10 }} onClick={() => setConfirmDelete(true)}>
            حذف القسم
          </button>
        ) : (
          <div style={{ marginTop: 10 }}>
            <div className="error-text">سيتم حذف القسم وكل بنوده ودفعاته وصوره نهائيًا. هل أنت متأكد؟</div>
            <button className="btn btn-danger btn-block" onClick={remove} disabled={loading}>تأكيد الحذف</button>
          </div>
        )}
      </div>
    </div>
  );
}

function NewItemModal({ categoryId, onClose, onCreated, showToast }) {
  const [name, setName] = useState('');
  const [hasAgreed, setHasAgreed] = useState(true);
  const [agreed, setAgreed] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api('POST', '/api/items', {
        category_id: categoryId,
        name,
        has_agreed: hasAgreed,
        agreed: hasAgreed ? parseFloat(agreed) || 0 : 0
      });
      onCreated();
    } catch (e) {
      showToast(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header-row">
          <div className="modal-title">بند جديد</div>
          <button type="button" className="modal-close-btn" onClick={onClose}>×</button>
        </div>
        <form onSubmit={submit}>
          <div className="field">
            <label>اسم البند</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>
          <div className="settings-row" style={{ marginBottom: 14 }}>
            <span>تفعيل المبلغ المتفق عليه لهذا البند</span>
            <Switch on={hasAgreed} onToggle={() => setHasAgreed((v) => !v)} />
          </div>
          {hasAgreed && (
            <div className="field">
              <label>المتفق عليه</label>
              <input type="number" step="0.01" value={agreed} onChange={(e) => setAgreed(e.target.value)} />
            </div>
          )}
          <button className="btn btn-primary btn-block" type="submit" disabled={loading}>حفظ</button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings Screen
// ---------------------------------------------------------------------------
function Switch({ on, onToggle }) {
  return (
    <button type="button" className={`switch ${on ? 'on' : ''}`} onClick={onToggle}>
      <span className="knob" />
    </button>
  );
}

// A custom dropdown (instead of a native <select>) so the option list always
// scrolls reliably and every option stays reachable, regardless of platform.
function Dropdown({ value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div className="dropdown-wrap" ref={wrapRef}>
      <button type="button" className="dropdown-trigger" onClick={() => setOpen((o) => !o)}>
        <span>{value}</span>
        <span className="dropdown-caret">▾</span>
      </button>
      {open && (
        <div className="dropdown-list">
          {options.map((o) => (
            <div
              key={o}
              className={`dropdown-item ${o === value ? 'active' : ''}`}
              onClick={() => {
                onChange(o);
                setOpen(false);
              }}
            >
              {o}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SettingsScreen({ ctx }) {
  const { user, settings } = ctx;
  const [local, setLocal] = useState(settings);
  const [cloud, setCloud] = useState(null);
  const [cloudLoading, setCloudLoading] = useState(true);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const restoreInputRef = useRef(null);

  useEffect(() => setLocal(settings), [settings]);

  const loadCloud = useCallback(async () => {
    setCloudLoading(true);
    try {
      const data = await api('GET', '/api/cloud/status');
      setCloud(data);
    } catch (e) {
      ctx.showToast(e.message);
    } finally {
      setCloudLoading(false);
    }
  }, [ctx]);

  useEffect(() => {
    loadCloud();
  }, [loadCloud]);

  const patchSettings = async (patch) => {
    setLocal((l) => ({ ...l, ...patch }));
    try {
      await api('PATCH', '/api/settings', patch);
      await ctx.refreshSettings();
      loadCloud();
    } catch (e) {
      ctx.showToast(e.message);
    }
  };

  const exportBackup = async () => {
    try {
      await downloadBlob('/api/backup', `ammar-backup-${user.username}-${Date.now()}.zip`);
    } catch (e) {
      ctx.showToast(e.message);
    }
  };

  const importBackup = async (file) => {
    if (!file) return;
    setRestoring(true);
    const form = new FormData();
    form.append('file', file);
    try {
      await api('POST', '/api/restore', form, true);
      ctx.showToast('تم استيراد النسخة الاحتياطية بنجاح');
    } catch (e) {
      ctx.showToast(e.message);
    } finally {
      setRestoring(false);
    }
  };

  const backupNow = async () => {
    try {
      await api('POST', '/api/cloud/backup-now');
      ctx.showToast('تم رفع النسخة الاحتياطية');
      loadCloud();
    } catch (e) {
      ctx.showToast(e.message);
    }
  };

  const restoreCloud = async (key) => {
    try {
      await api('POST', `/api/cloud/restore/${encodeURIComponent(key)}`);
      ctx.showToast('تم الاسترجاع بنجاح');
    } catch (e) {
      ctx.showToast(e.message);
    }
  };

  const deleteCloud = async (key) => {
    try {
      await api('DELETE', `/api/cloud/${encodeURIComponent(key)}`);
      loadCloud();
    } catch (e) {
      ctx.showToast(e.message);
    }
  };

  if (!local) return <div className="spinner-wrap muted">جارِ التحميل...</div>;

  return (
    <div>
      <div className="topbar">
        <button className="icon-btn" onClick={ctx.back}>→</button>
        <h2>الإعدادات</h2>
      </div>
      <div className="container">
        <div className="settings-section card">
          <div className="card-title">المظهر</div>
          <div className="theme-options">
            {[
              { key: 'light', label: 'فاتح' },
              { key: 'dark', label: 'داكن' },
              { key: 'system', label: 'حسب النظام' }
            ].map((opt) => (
              <div
                key={opt.key}
                className={`theme-option ${local.theme === opt.key ? 'active' : ''}`}
                onClick={() => patchSettings({ theme: opt.key })}
              >
                {opt.label}
              </div>
            ))}
          </div>
        </div>

        <div className="settings-section card">
          <div className="card-title">النسخة الاحتياطية المحلية</div>
          <button className="btn btn-secondary btn-block" style={{ marginBottom: 10 }} onClick={exportBackup}>
            ⬇ تصدير نسخة
          </button>
          <button className="btn btn-secondary btn-block" onClick={() => restoreInputRef.current.click()} disabled={restoring}>
            ⬆ استيراد نسخة
          </button>
          <input
            ref={restoreInputRef}
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            onChange={(e) => importBackup(e.target.files[0])}
          />
        </div>

        <div className="settings-section card">
          <div className="card-title">النسخ الاحتياطي السحابي (S3)</div>
          {cloudLoading && <div className="muted">جارِ التحميل...</div>}
          {!cloudLoading && cloud && !cloud.configured && (
            <div>
              <div className="muted" style={{ marginBottom: 10 }}>
                لتفعيل النسخ السحابي، أضف متغيرات البيئة التالية عند تشغيل الحاوية:
              </div>
              <ul style={{ fontSize: 13, color: 'var(--muted)' }}>
                {cloud.required_env.map((v) => <li key={v}>{v}</li>)}
              </ul>
            </div>
          )}
          {!cloudLoading && cloud && cloud.configured && (
            <div>
              <div className="stat-line"><span>الحاوية (Bucket)</span><span>{cloud.bucket}</span></div>
              <div className="stat-line"><span>البادئة (Prefix)</span><span>{cloud.prefix}</span></div>
              <div className="stat-line"><span>موعد النسخ اليومي</span><span>{cloud.schedule}</span></div>

              <button className="btn btn-primary btn-block" style={{ margin: '14px 0' }} onClick={backupNow}>
                ☁ رفع نسخة الآن
              </button>

              <div className="settings-row">
                <span>تفعيل النسخ التلقائي</span>
                <Switch on={local.backup_enabled} onToggle={() => patchSettings({ backup_enabled: !local.backup_enabled })} />
              </div>
              <div className="settings-row">
                <span>وقت النسخ اليومي</span>
                <input
                  type="time"
                  style={{ minHeight: 40, width: 120 }}
                  value={local.backup_time || '03:00'}
                  onChange={(e) => patchSettings({ backup_time: e.target.value })}
                />
              </div>
              <div className="settings-row">
                <span>بلا حد للاحتفاظ</span>
                <Switch
                  on={local.backup_keep_unlimited}
                  onToggle={() => patchSettings({ backup_keep_unlimited: !local.backup_keep_unlimited })}
                />
              </div>

              <div className="section-title">النسخ الاحتياطية السحابية</div>
              {cloud.backups.length === 0 && <div className="muted">لا توجد نسخ بعد.</div>}
              {cloud.backups.map((b) => (
                <div key={b.key} className="backup-item">
                  <div>
                    <div>{b.key.split('/').pop()}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {new Date(b.last_modified).toLocaleString('ar')} — {(b.size / 1024).toFixed(0)} كيلوبايت
                    </div>
                  </div>
                  <div className="backup-actions">
                    <button className="link-btn" onClick={() => restoreCloud(b.key)}>استرجاع</button>
                    <button className="link-btn" style={{ color: 'var(--danger)' }} onClick={() => deleteCloud(b.key)}>حذف</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {user.is_admin && (
          <div className="settings-section card">
            <button className="btn btn-secondary btn-block" onClick={() => ctx.push('users-admin')}>
              إدارة المستخدمين
            </button>
          </div>
        )}

        <div className="settings-section card danger-zone">
          <button className="btn btn-danger btn-block" onClick={() => setShowDeleteAccount(true)}>
            حذف حسابي
          </button>
        </div>

        <button className="btn btn-secondary btn-block" onClick={ctx.onLogout}>تسجيل خروج</button>
      </div>

      {showDeleteAccount && (
        <DeleteAccountModal
          username={user.username}
          onClose={() => setShowDeleteAccount(false)}
          onDeleted={ctx.onLogout}
          showToast={ctx.showToast}
        />
      )}
    </div>
  );
}

function DeleteAccountModal({ username, onClose, onDeleted, showToast }) {
  const [typedUsername, setTypedUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmStep, setConfirmStep] = useState(false);
  const [loading, setLoading] = useState(false);

  const proceed = () => {
    if (typedUsername !== username) {
      showToast('اسم المستخدم غير مطابق');
      return;
    }
    if (!password) {
      showToast('كلمة المرور مطلوبة');
      return;
    }
    setConfirmStep(true);
  };

  const finalDelete = async () => {
    setLoading(true);
    try {
      await api('DELETE', '/api/account', { password });
      onDeleted();
    } catch (e) {
      showToast(e.message);
      setConfirmStep(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header-row">
          <div className="modal-title">حذف الحساب</div>
          <button type="button" className="modal-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="error-text">
          سيتم حذف حسابك وكل مشاريعك وبنودك ودفعاتك وصورك نهائيًا.
        </div>
        {!confirmStep ? (
          <>
            <div className="field">
              <label>اكتب اسم المستخدم "{username}" للتأكيد</label>
              <input type="text" value={typedUsername} onChange={(e) => setTypedUsername(e.target.value)} />
            </div>
            <div className="field">
              <label>كلمة المرور</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <button className="btn btn-danger btn-block" onClick={proceed}>متابعة</button>
          </>
        ) : (
          <>
            <div className="error-text">هل أنت متأكد تمامًا؟ هذا الإجراء نهائي ولا يمكن التراجع عنه.</div>
            <button className="btn btn-danger btn-block" onClick={finalDelete} disabled={loading}>
              حذف نهائي
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Users Admin Screen
// ---------------------------------------------------------------------------
function UsersAdminScreen({ ctx }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [regOpen, setRegOpen] = useState(false);
  const [showNewUser, setShowNewUser] = useState(false);
  const [resetTarget, setResetTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [usersData, adminSettings] = await Promise.all([
        api('GET', '/api/users'),
        api('GET', '/api/admin/settings')
      ]);
      setUsers(usersData.users);
      setRegOpen(adminSettings.registration_open);
    } catch (e) {
      ctx.showToast(e.message);
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleRegistration = async () => {
    try {
      const data = await api('PATCH', '/api/admin/settings', { registration_open: !regOpen });
      setRegOpen(data.registration_open);
    } catch (e) {
      ctx.showToast(e.message);
    }
  };

  const toggleActive = async (u) => {
    try {
      await api('PATCH', `/api/users/${u.id}`, { is_active: !u.is_active });
      load();
    } catch (e) {
      ctx.showToast(e.message);
    }
  };

  return (
    <div>
      <div className="topbar">
        <button className="icon-btn" onClick={ctx.back}>→</button>
        <h2>إدارة المستخدمين</h2>
        <button className="btn btn-primary fab-top-right" onClick={() => setShowNewUser(true)}>＋ إضافة مستخدم</button>
      </div>
      <div className="container">
        <div className="card">
          <div className="settings-row">
            <span>فتح/إغلاق التسجيل العام</span>
            <Switch on={regOpen} onToggle={toggleRegistration} />
          </div>
        </div>

        {loading && <div className="spinner-wrap muted">جارِ التحميل...</div>}
        {!loading && users.map((u) => (
          <div key={u.id} className="card">
            <div className="row-between">
              <div>
                <div className="card-title">{u.display_name || u.username}</div>
                <div className="muted" style={{ fontSize: 13 }}>@{u.username}</div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {u.is_admin && <span className="badge badge-admin">أدمن</span>}
                <span className={`badge ${u.is_active ? 'badge-muted' : 'badge-danger'}`}>
                  {u.is_active ? 'مفعل' : 'معطل'}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" onClick={() => setResetTarget(u)}>إعادة تعيين كلمة المرور</button>
              <button className="btn btn-secondary" onClick={() => toggleActive(u)}>
                {u.is_active ? 'تعطيل' : 'تفعيل'}
              </button>
              <button className="btn btn-danger" onClick={() => setDeleteTarget(u)}>حذف</button>
            </div>
          </div>
        ))}
      </div>

      {showNewUser && (
        <NewUserModal
          onClose={() => setShowNewUser(false)}
          onCreated={() => {
            setShowNewUser(false);
            load();
          }}
          showToast={ctx.showToast}
        />
      )}

      {resetTarget && (
        <ResetPasswordModal
          user={resetTarget}
          onClose={() => setResetTarget(null)}
          onDone={() => {
            setResetTarget(null);
            ctx.showToast('تم تغيير كلمة المرور');
          }}
          showToast={ctx.showToast}
        />
      )}

      {deleteTarget && (
        <DeleteUserModal
          user={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null);
            load();
          }}
          showToast={ctx.showToast}
        />
      )}
    </div>
  );
}

function NewUserModal({ onClose, onCreated, showToast }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api('POST', '/api/users', { username, password, display_name: displayName });
      onCreated();
    } catch (e) {
      showToast(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header-row">
          <div className="modal-title">إضافة مستخدم</div>
          <button type="button" className="modal-close-btn" onClick={onClose}>×</button>
        </div>
        <form onSubmit={submit}>
          <div className="field">
            <label>اسم المستخدم</label>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div className="field">
            <label>الاسم الظاهر</label>
            <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="field">
            <label>كلمة المرور</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={loading}>إضافة</button>
        </form>
      </div>
    </div>
  );
}

function ResetPasswordModal({ user, onClose, onDone, showToast }) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api('POST', `/api/users/${user.id}/reset-password`, { new_password: password });
      onDone();
    } catch (e) {
      showToast(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header-row">
          <div className="modal-title">إعادة تعيين كلمة المرور — {user.username}</div>
          <button type="button" className="modal-close-btn" onClick={onClose}>×</button>
        </div>
        <form onSubmit={submit}>
          <div className="field">
            <label>كلمة المرور الجديدة</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={loading}>حفظ</button>
        </form>
      </div>
    </div>
  );
}

function DeleteUserModal({ user, onClose, onDeleted, showToast }) {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);

  const remove = async () => {
    setLoading(true);
    try {
      await api('DELETE', `/api/users/${user.id}`);
      onDeleted();
    } catch (e) {
      showToast(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header-row">
          <div className="modal-title">حذف المستخدم — {user.username}</div>
          <button type="button" className="modal-close-btn" onClick={onClose}>×</button>
        </div>
        {step === 1 ? (
          <>
            <div className="error-text">سيتم حذف هذا المستخدم وكل بياناته نهائيًا.</div>
            <button className="btn btn-danger btn-block" onClick={() => setStep(2)}>متابعة</button>
          </>
        ) : (
          <>
            <div className="error-text">هل أنت متأكد تمامًا؟ هذا الإجراء نهائي.</div>
            <button className="btn btn-danger btn-block" onClick={remove} disabled={loading}>تأكيد الحذف</button>
          </>
        )}
      </div>
    </div>
  );
}
