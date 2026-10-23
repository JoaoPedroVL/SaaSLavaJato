/* =============================================================
   Painel master do SaaS
   Lista todos os lava-jatos, donos e cobranças.
   O acesso total aos dados de cada tenant passa pelo RLS
   (public.is_platform_admin()).
   ============================================================= */
(function () {
  "use strict";

  const CFG = window.ADMIN_CONFIG || {};
  const SESSION_KEY = "lavajato_master_session";
  const THEME_KEY = "lavajato_theme";
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------- tema ---------------- */
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const currentTheme = () => document.documentElement.dataset.theme === "dark" ? "dark" : "light";

  function applyTheme(theme, persist) {
    document.documentElement.dataset.theme = theme;
    const label = theme === "dark" ? "Ativar tema claro" : "Ativar tema escuro";
    document.querySelectorAll("[data-theme-toggle]").forEach(btn => {
      btn.setAttribute("aria-label", label);
      btn.title = label;
    });
    if (themeMeta) themeMeta.setAttribute("content", theme === "dark" ? "#0b1320" : "#0a1526");
    if (persist) {
      try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* modo privado */ }
    }
  }

  applyTheme(currentTheme());
  document.addEventListener("click", e => {
    if (!e.target.closest("[data-theme-toggle]")) return;
    applyTheme(currentTheme() === "dark" ? "light" : "dark", true);
  });
  const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  if (themeMedia.addEventListener) {
    themeMedia.addEventListener("change", e => {
      let saved = null;
      try { saved = localStorage.getItem(THEME_KEY); } catch (err) { /* ignora */ }
      if (!saved) applyTheme(e.matches ? "dark" : "light");
    });
  }

  /* ---------------- estado ---------------- */
  let session = null;
  let user = null;
  let tenants = [];
  let editing = null;
  let slugTouched = false;

  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const money = cents => {
    if (cents == null || cents === "") return "—";
    const v = Number(cents) / 100;
    return "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  function fmtDate(date) {
    if (!date) return "—";
    const [y, m, d] = String(date).slice(0, 10).split("-");
    if (!y || !m || !d) return date;
    return `${d}/${m}/${y}`;
  }

  function fmtPhone(p) {
    const d = String(p || "").replace(/\D/g, "");
    const local = d.startsWith("55") && d.length > 11 ? d.slice(2) : d;
    if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
    if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
    return p || "";
  }

  function slugify(value) {
    return String(value || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  }

  function parseMoney(value) {
    let s = String(value || "").replace(/[^\d,.-]/g, "").replace(/-/g, "").trim();
    if (!s) return null;
    if (s.includes(",")) {
      // formato brasileiro: 1.200,50
      s = s.replace(/\./g, "").replace(",", ".");
    } else if (s.includes(".")) {
      const parts = s.split(".");
      if (parts.length > 2) {
        const cents = parts.pop();
        s = parts.join("") + "." + cents;
      } else if (parts[1].length === 3) {
        // 1.200 digitado como milhar, não como 1,20
        s = parts[0] + parts[1];
      }
    }
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
  }

  function metaOf(t) {
    const m = t && t.tenant_meta;
    return (Array.isArray(m) ? m[0] : m) || {};
  }

  function effectiveStatus(t) {
    const m = metaOf(t);
    if (m.billing_status === "pending" && m.billing_due_date && m.billing_due_date < todayISO()) {
      return "overdue";
    }
    return m.billing_status || "pending";
  }

  const BILLING = {
    paid: "Pago",
    pending: "Pendente",
    overdue: "Atrasado",
    trial: "Em teste",
    cancelled: "Cancelado"
  };

  /* ---------------- sessão / auth ---------------- */
  function readSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveSession(data) {
    session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      email: (data.user && data.user.email) || (session && session.email) || ""
    };
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
  }

  function clearSession() {
    session = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  async function authRequest(path, body, token) {
    const res = await fetch(CFG.supabaseUrl.replace(/\/$/, "") + "/auth/v1/" + path, {
      method: "POST",
      headers: {
        apikey: CFG.supabaseAnonKey,
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) {}
    if (!res.ok) {
      const err = new Error(data.error_description || data.msg || data.error || "auth_error");
      err.code = data.error || data.error_code || "auth_error";
      throw err;
    }
    return data;
  }

  async function refreshSession() {
    if (!session || !session.refresh_token) throw new Error("no_session");
    const data = await authRequest("token?grant_type=refresh_token", { refresh_token: session.refresh_token });
    saveSession(data);
    return data;
  }

  let refreshPromise = null;
  function sessionExpired() {
    clearSession();
    showLogin("Sua sessão expirou. Entre de novo.");
  }
  function renewSession() {
    if (!refreshPromise) {
      refreshPromise = refreshSession().finally(() => { refreshPromise = null; });
    }
    return refreshPromise;
  }

  async function ensureSession() {
    if (!session) {
      sessionExpired();
      throw new Error("no_session");
    }
    if (Date.now() < session.expires_at - 60000) return;
    try {
      await renewSession();
    } catch (e) {
      sessionExpired();
      throw e;
    }
  }

  async function getMe() {
    await ensureSession();
    const res = await fetch(CFG.supabaseUrl.replace(/\/$/, "") + "/auth/v1/user", {
      headers: { apikey: CFG.supabaseAnonKey, Authorization: "Bearer " + session.access_token }
    });
    if (!res.ok) throw new Error("unauthorized");
    return res.json();
  }

  async function api(path, opts = {}, retried = false) {
    await ensureSession();
    const res = await fetch(CFG.supabaseUrl.replace(/\/$/, "") + "/rest/v1/" + path, {
      ...opts,
      headers: {
        apikey: CFG.supabaseAnonKey,
        Authorization: "Bearer " + session.access_token,
        "Content-Type": "application/json",
        ...(opts.headers || {})
      }
    });

    if (res.status === 401 && !retried) {
      try {
        await renewSession();
      } catch (e) {
        sessionExpired();
        throw e;
      }
      return api(path, opts, true);
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      const err = new Error((data && (data.message || data.hint || data.details)) || "api_error");
      err.status = res.status;
      err.code = data && data.code;
      throw err;
    }
    return data;
  }

  /* ---------------- views ---------------- */
  const loginView = $("#loginView");
  const appView = $("#appView");
  const loginForm = $("#loginForm");
  const loginError = $("#loginError");
  const loginBtn = $("#loginBtn");

  function showLogin(message) {
    appView.hidden = true;
    loginView.hidden = false;
    loginError.hidden = !message;
    if (message) loginError.textContent = message;
    loginBtn.disabled = false;
    loginBtn.textContent = "Entrar";
    setTimeout(() => $("#email").focus(), 50);
  }

  function showApp() {
    loginView.hidden = true;
    appView.hidden = false;
  }

  loginForm.addEventListener("submit", async e => {
    e.preventDefault();
    loginError.hidden = true;
    loginBtn.disabled = true;
    loginBtn.textContent = "Entrando…";

    try {
      const data = await authRequest("token?grant_type=password", {
        email: $("#email").value.trim(),
        password: $("#password").value
      });
      saveSession(data);
      user = data.user || null;
      await start();
    } catch (err) {
      clearSession();
      let msg = "Não consegui entrar agora. Tente de novo.";
      if (err.status === 403 || /platform|permission|not authorized|acesso/i.test(err.message || "")) {
        msg = "Esta conta não tem acesso ao painel master.";
      } else if (/invalid|credential|grant/i.test(err.message || "")) {
        msg = "E-mail ou senha incorretos.";
      } else if (/relation|platform_admins|schema cache|does not exist/i.test(err.message || "")) {
        msg = "O painel master ainda não está ativo no banco. Rode a migração 20261023000000_platform_admin.sql no Supabase.";
      }
      showLogin(msg);
    }
  });

  async function logout() {
    try {
      if (session) await authRequest("logout", null, session.access_token);
    } catch (e) { /* sessão já pode ter expirado */ }
    clearSession();
    tenants = [];
    showLogin("");
    loginForm.reset();
  }

  /* ---------------- início ---------------- */
  async function start() {
    if (!user) user = await getMe();

    let admins = [];
    try {
      admins = await api("platform_admins?select=user_id,name&limit=1");
    } catch (err) {
      if (/relation|platform_admins|schema cache|does not exist/i.test(err.message || "")) {
        throw new Error("Rode a migração 20261023000000_platform_admin.sql no Supabase para ativar o painel master.");
      }
      throw err;
    }

    if (!admins || !admins.length) {
      clearSession();
      showLogin("Esta conta não tem acesso ao painel master.");
      return;
    }

    $("#userEmail").textContent = (user && user.email) || (session && session.email) || "";
    await loadTenants();
    showApp();
  }

  async function loadTenants() {
    const rows = await api(
      "tenants?select=id,slug,name,timezone,whatsapp,address,active,created_at,"
      + "tenant_meta(owner_name,owner_email,owner_phone,billing_status,billing_amount_cents,"
      + "billing_due_date,billing_paid_at,billing_notes,internal_notes,updated_at)"
      + "&order=name.asc"
    );
    tenants = (rows || []).map(t => ({ ...t, meta: metaOf(t) }));
    render();
  }

  function render() {
    renderStats();
    renderList();
  }

  function renderStats() {
    const total = tenants.length;
    const active = tenants.filter(t => t.active).length;
    const paid = tenants.filter(t => effectiveStatus(t) === "paid").length;
    const pending = tenants.filter(t => ["pending", "overdue"].includes(effectiveStatus(t))).length;
    $("#stats").innerHTML = `
      <div class="stat-card"><span>Total</span><b>${total}</b><small>lava-jatos</small></div>
      <div class="stat-card"><span>Ativos</span><b>${active}</b><small>com site no ar</small></div>
      <div class="stat-card"><span>Em dia</span><b>${paid}</b><small>faturas pagas</small></div>
      <div class="stat-card"><span>Pendências</span><b>${pending}</b><small>pendentes ou atrasadas</small></div>`;
  }

  function filteredTenants() {
    const q = ($("#searchInput").value || "").trim().toLowerCase();
    const filter = $("#statusFilter").value;
    return tenants.filter(t => {
      const status = effectiveStatus(t);
      if (filter === "suspended" && t.active) return false;
      if (filter && filter !== "suspended" && status !== filter) return false;
      if (!q) return true;
      const hay = [
        t.name, t.slug, t.whatsapp, t.address,
        t.meta.owner_name, t.meta.owner_email, t.meta.owner_phone
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }

  function renderList() {
    const list = $("#tenantList");
    const rows = filteredTenants();
    if (!rows.length) {
      const hasAny = tenants.length > 0;
      list.innerHTML = `<div class="empty"><b>${hasAny ? "Nenhum resultado" : "Nenhum lava-jato cadastrado"}</b>
        ${hasAny ? "Tente outro nome ou filtro." : "Cadastre o primeiro lava-jato para começar."}
        ${hasAny ? "" : '<br><button type="button" class="btn" id="emptyNewBtn">+ Novo lava-jato</button>'}</div>`;
      const emptyBtn = $("#emptyNewBtn");
      if (emptyBtn) emptyBtn.addEventListener("click", () => openModal());
      return;
    }

    list.innerHTML = rows.map(t => {
      const m = t.meta || {};
      const status = effectiveStatus(t);
      const statusLabel = BILLING[status] || "Pendente";
      const owner = m.owner_name || "Dono não informado";
      const phone = m.owner_phone || t.whatsapp || "";
      const email = m.owner_email || "";
      const due = m.billing_due_date ? "Vence " + fmtDate(m.billing_due_date) : "Sem vencimento";
      const paidButton = status === "paid"
        ? `<button type="button" class="btn-sm" data-pending="${esc(t.id)}">Marcar pendente</button>`
        : `<button type="button" class="btn-sm ok" data-paid="${esc(t.id)}">Marcar pago</button>`;
      return `<article class="tenant-row" data-id="${esc(t.id)}">
        <div class="t-main">
          <div class="t-title">
            <b>${esc(t.name)}</b>
            <span class="pill ${t.active ? "active" : "suspended"}">${t.active ? "Ativo" : "Suspenso"}</span>
          </div>
          <div class="t-slug">?loja=${esc(t.slug)}</div>
          <div class="t-owner">
            <span>${esc(owner)}</span>
            ${phone ? `<span class="muted">${esc(fmtPhone(phone))}</span>` : ""}
            ${email ? `<span class="t-email">${esc(email)}</span>` : ""}
          </div>
        </div>
        <div class="t-bill">
          <span class="pill ${status}">${statusLabel}</span>
          <b>${money(m.billing_amount_cents)}</b>
          <small>${esc(due)}</small>
        </div>
        <div class="t-actions">
          <a class="btn-sm primary" href="../admin/?tenant=${encodeURIComponent(t.slug)}" target="_blank" rel="noopener">Abrir painel</a>
          <a class="btn-sm" href="../?loja=${encodeURIComponent(t.slug)}" target="_blank" rel="noopener">Site</a>
          <button type="button" class="btn-sm" data-edit="${esc(t.id)}">Editar</button>
          ${paidButton}
        </div>
      </article>`;
    }).join("");
  }

  $("#searchInput").addEventListener("input", renderList);
  $("#statusFilter").addEventListener("change", renderList);

  $("#tenantList").addEventListener("click", async e => {
    const editBtn = e.target.closest("[data-edit]");
    if (editBtn) {
      const t = tenants.find(x => x.id === editBtn.dataset.edit);
      if (t) openModal(t);
      return;
    }

    const paidBtn = e.target.closest("[data-paid]");
    if (paidBtn) {
      await quickBilling(paidBtn.dataset.paid, "paid");
      return;
    }

    const pendingBtn = e.target.closest("[data-pending]");
    if (pendingBtn) {
      await quickBilling(pendingBtn.dataset.pending, "pending");
    }
  });

  async function quickBilling(id, status) {
    const t = tenants.find(x => x.id === id);
    if (!t) return;
    try {
      await api("tenant_meta?on_conflict=tenant_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({
          tenant_id: id,
          billing_status: status,
          billing_paid_at: status === "paid" ? new Date().toISOString() : null,
          updated_at: new Date().toISOString()
        })
      });
      toast(status === "paid" ? "Fatura marcada como paga." : "Fatura marcada como pendente.");
      await loadTenants();
    } catch (err) {
      toast("Não consegui atualizar a cobrança: " + (err.message || "erro"), true);
    }
  }

  /* ---------------- modal ---------------- */
  const modal = $("#tenantModal");
  const form = $("#tenantForm");
  const saveBtn = $("#tenantSave");

  function openModal(t) {
    editing = t || null;
    slugTouched = !!t;
    $("#tenantModalTitle").textContent = t ? "Editar lava-jato" : "Novo lava-jato";
    $("#tenantModalLead").textContent = t
      ? "Ajuste os dados do estabelecimento, do dono e da cobrança."
      : "Cadastre o estabelecimento e o contato do dono.";
    $("#tenantName").value = t ? t.name : "";
    $("#tenantSlug").value = t ? t.slug : "";
    $("#tenantSlug").disabled = !!t;
    $("#tenantWhats").value = t ? (t.whatsapp || "") : "";
    $("#tenantAddress").value = t ? (t.address || "") : "";
    $("#tenantTimezone").value = t ? (t.timezone || "America/Sao_Paulo") : "America/Sao_Paulo";
    $("#tenantActive").checked = t ? !!t.active : true;

    const m = t ? (t.meta || {}) : {};
    $("#ownerName").value = m.owner_name || "";
    $("#ownerEmail").value = m.owner_email || "";
    $("#ownerPhone").value = m.owner_phone || "";
    $("#billingStatus").value = m.billing_status || "pending";
    $("#billingAmount").value = m.billing_amount_cents != null
      ? (Number(m.billing_amount_cents) / 100).toFixed(2).replace(".", ",")
      : "";
    $("#billingDue").value = m.billing_due_date || "";
    $("#billingNotes").value = m.billing_notes || "";
    $("#internalNotes").value = m.internal_notes || "";

    $("#ownerAccess").hidden = !(t && m.owner_email);
    $("#openSupabaseUsers").href = supabaseUsersUrl();
    $("#slugHint").innerHTML = t
      ? `O link público é <b>?loja=${esc(t.slug)}</b>.`
      : `O link ficará <b>?loja=slug</b>. Depois de salvo, o slug não muda.`;
    $("#tenantFormError").hidden = true;
    modal.hidden = false;
    setTimeout(() => $("#tenantName").focus(), 50);
  }

  function closeModal() {
    modal.hidden = true;
    editing = null;
    saveBtn.disabled = false;
    saveBtn.textContent = "Salvar lava-jato";
  }

  $("#tenantModalClose").addEventListener("click", closeModal);
  $("#tenantCancel").addEventListener("click", closeModal);
  modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !modal.hidden) closeModal();
  });

  $("#newTenantBtn").addEventListener("click", () => openModal());

  $("#tenantName").addEventListener("input", () => {
    if (editing || slugTouched) return;
    $("#tenantSlug").value = slugify($("#tenantName").value);
  });
  $("#tenantSlug").addEventListener("input", () => { slugTouched = true; });
  $("#ownerEmail").addEventListener("input", () => {
    $("#ownerAccess").hidden = !$("#ownerEmail").value.trim();
  });

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const name = $("#tenantName").value.trim();
    const slug = $("#tenantSlug").value.trim();
    if (!name) return;
    if (!editing && !/^[a-z0-9-]+$/.test(slug)) {
      showFormError("O link do site deve ter apenas letras minúsculas, números e hífen.");
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Salvando…";
    $("#tenantFormError").hidden = true;

    const tenantBody = {
      name,
      whatsapp: $("#tenantWhats").value.trim() || null,
      address: $("#tenantAddress").value.trim() || null,
      timezone: $("#tenantTimezone").value.trim() || "America/Sao_Paulo",
      active: $("#tenantActive").checked
    };

    const metaBody = {
      owner_name: $("#ownerName").value.trim() || null,
      owner_email: $("#ownerEmail").value.trim() || null,
      owner_phone: $("#ownerPhone").value.trim() || null,
      billing_status: $("#billingStatus").value,
      billing_amount_cents: parseMoney($("#billingAmount").value),
      billing_due_date: $("#billingDue").value || null,
      billing_notes: $("#billingNotes").value.trim() || null,
      internal_notes: $("#internalNotes").value.trim() || null,
      updated_at: new Date().toISOString()
    };
    metaBody.billing_paid_at = metaBody.billing_status === "paid"
      ? ((editing && editing.meta && editing.meta.billing_paid_at) || new Date().toISOString())
      : null;

    try {
      if (!editing) {
        tenantBody.slug = slug;
        const created = await api("tenants", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(tenantBody)
        });
        const tenantId = created && created[0] && created[0].id;
        if (!tenantId) throw new Error("Não recebi o id do lava-jato criado.");

        await api("tenant_meta", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ tenant_id: tenantId, ...metaBody })
        });

        await api("tenant_site", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ tenant_id: tenantId })
        }).catch(() => { /* a landing usa os padrões mesmo sem linha */ });

        await api("business_hours", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(defaultHours(tenantId))
        }).catch(() => { /* o dono pode ajustar depois */ });

        await api("boxes", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ tenant_id: tenantId, name: "Box 1", sort_order: 1 })
        }).catch(() => { /* o dono pode criar depois */ });

        toast("Lava-jato criado. Abra o painel para cadastrar serviços e horários.");
      } else {
        await api("tenants?id=eq." + encodeURIComponent(editing.id), {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(tenantBody)
        });
        await api("tenant_meta?on_conflict=tenant_id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify({ tenant_id: editing.id, ...metaBody })
        });
        toast("Lava-jato atualizado.");
      }

      await loadTenants();
      closeModal();
    } catch (err) {
      const msg = /duplicate|unique|23505/i.test(err.message || "")
        ? "Já existe um lava-jato com esse link. Escolha outro slug."
        : (err.message || "Não consegui salvar agora.");
      showFormError(msg);
      saveBtn.disabled = false;
      saveBtn.textContent = "Salvar lava-jato";
    }
  });

  function showFormError(message) {
    const el = $("#tenantFormError");
    el.textContent = message;
    el.hidden = false;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function defaultHours(tenantId) {
    const rows = [
      { weekday: 0, opens_at: null, closes_at: null, closed: true },
      { weekday: 1, opens_at: "08:00", closes_at: "18:00", closed: false },
      { weekday: 2, opens_at: "08:00", closes_at: "18:00", closed: false },
      { weekday: 3, opens_at: "08:00", closes_at: "18:00", closed: false },
      { weekday: 4, opens_at: "08:00", closes_at: "18:00", closed: false },
      { weekday: 5, opens_at: "08:00", closes_at: "18:00", closed: false },
      { weekday: 6, opens_at: "08:00", closes_at: "13:00", closed: false }
    ];
    return rows.map(r => ({ tenant_id: tenantId, ...r }));
  }

  function supabaseUsersUrl() {
    const m = String(CFG.supabaseUrl || "").match(/^https?:\/\/([^.]+)\.supabase\.co/);
    const ref = m ? m[1] : "mcccxsovuouleorxfgnr";
    return `https://supabase.com/dashboard/project/${ref}/auth/users`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  $("#copyAccessSql").addEventListener("click", async () => {
    if (!editing) return;
    const email = $("#ownerEmail").value.trim();
    const slug = editing.slug;
    if (!email) {
      showFormError("Preencha o e-mail do dono antes de copiar o SQL.");
      return;
    }
    const q = s => String(s || "").replace(/'/g, "''");
    const sql = `insert into public.memberships (user_id, tenant_id, role)\n`
      + `select u.id, t.id, 'owner'\n`
      + `from auth.users u\n`
      + `join public.tenants t on t.slug = '${q(slug)}'\n`
      + `where u.email = '${q(email)}'\n`
      + `on conflict (user_id, tenant_id) do update set role = excluded.role;`;
    const ok = await copyText(sql);
    toast(ok ? "SQL copiado. Cole no SQL Editor do Supabase." : "Não consegui copiar. Abra o SQL no README.", !ok);
  });

  /* ---------------- extras ---------------- */
  $("#refreshBtn").addEventListener("click", async () => {
    const btn = $("#refreshBtn");
    btn.disabled = true;
    btn.textContent = "Atualizando…";
    try {
      await loadTenants();
      toast("Lista atualizada.");
    } catch (err) {
      toast("Não consegui atualizar: " + (err.message || "erro"), true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Atualizar";
    }
  });

  $("#logoutBtn").addEventListener("click", logout);

  let toastTimer = null;
  function toast(message, isError) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.toggle("err", !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3800);
  }

  /* ---------------- boot ---------------- */
  (async function boot() {
    session = readSession();
    if (!session) {
      showLogin("");
      return;
    }
    try {
      user = await getMe();
      await start();
    } catch (err) {
      clearSession();
      const msg = /migração|migracao|platform_admins|relation/i.test(err.message || "")
        ? err.message
        : "Sua sessão expirou. Entre de novo.";
      showLogin(msg);
    }
  })();
})();
