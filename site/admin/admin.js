/* =============================================================
   Painel do lava-jato
   Login (Supabase Auth) → agenda, clientes e resumo.
   Tudo passa pelo RLS: o usuário só enxerga o lava-jato dele.
   ============================================================= */
(function () {
  "use strict";

  const CFG = window.ADMIN_CONFIG || {};
  const SESSION_KEY = "lavajato_admin_session";
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const WEEK_SHORT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

  /* ---------------- tema (claro/escuro) ---------------- */
  const THEME_KEY = "lavajato_theme";
  const themeMeta = document.querySelector('meta[name="theme-color"]');

  function currentTheme() {
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  }

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

  const STATUS = {
    pending: { label: "Pendente", cls: "pending" },
    confirmed: { label: "Confirmado", cls: "confirmed" },
    done: { label: "Concluído", cls: "done" },
    no_show: { label: "Faltou", cls: "noshow" },
    cancelled: { label: "Cancelado", cls: "cancelled" }
  };

  const BOOKING_FIELDS = "id,code,starts_at,ends_at,price_cents,status,notes,vehicle_id,box_id,"
    + "customer:customers(id,name,phone),service:services(id,name),vehicle:vehicles(name),box:boxes(id,name)";

  /* ---------------- estado ---------------- */
  let session = null;
  let user = null;
  let memberships = [];
  let tenant = null;
  let hours = {};
  let currentDay = null;
  let currentTab = "agenda";
  let clientsCache = null;
  let activeClient = null;
  let boxes = [];
  let catalog = null;
  let svcEditor = { loaded: false, services: [], prices: [], vehicles: [] };
  let svcCategorySupported = true;
  let editing = null;
  let bkDay = { date: null, bookings: [], blocks: [] };
  let bookingSeq = 0;
  let agendaRows = [];

  /* ---------------- utilidades ---------------- */
  const money = cents => {
    const v = (cents || 0) / 100;
    const dec = cents % 100 === 0 ? 0 : 2;
    return "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: 2 });
  };

  function fmtPhone(p) {
    const d = String(p || "").replace(/\D/g, "");
    const local = d.startsWith("55") && d.length > 11 ? d.slice(2) : d;
    if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
    if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
    return p || "";
  }

  function waPhone(p) {
    const d = String(p || "").replace(/\D/g, "");
    return d.length > 11 ? d : "55" + d;
  }

  const onlyDigits = p => String(p || "").replace(/\D/g, "");
  const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;

  function localDay(iso) {
    const p = partsInTz(new Date(iso), tenant.timezone);
    return `${p.year}-${p.month}-${p.day}`;
  }

  function localHHMM(iso) {
    const p = partsInTz(new Date(iso), tenant.timezone);
    return `${p.hour}:${p.minute}`;
  }

  function partsInTz(date, tz) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    });
    const o = {};
    for (const p of fmt.formatToParts(date)) o[p.type] = p.value;
    return o;
  }

  function tzOffsetMs(date, tz) {
    const p = partsInTz(date, tz);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime();
  }

  function zonedToUtc(dateStr, hhmm, tz) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const [h, mi] = hhmm.split(":").map(Number);
    const naive = Date.UTC(y, m - 1, d, h, mi, 0);
    let off = tzOffsetMs(new Date(naive), tz);
    off = tzOffsetMs(new Date(naive - off), tz);
    return new Date(naive - off);
  }

  function todayInTz(tz = tenant.timezone) {
    const p = partsInTz(new Date(), tz);
    return `${p.year}-${p.month}-${p.day}`;
  }

  function addDays(dateStr, n) {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  const weekdayOf = dateStr => new Date(dateStr + "T00:00:00Z").getUTCDay();

  function fmtDateLong(dateStr) {
    const s = new Intl.DateTimeFormat("pt-BR", {
      weekday: "long", day: "2-digit", month: "long", timeZone: "UTC"
    }).format(new Date(dateStr + "T12:00:00Z"));
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function fmtDateShort(iso) {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: tenant.timezone, day: "2-digit", month: "2-digit"
    }).format(new Date(iso));
  }

  function fmtDateTime(iso) {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: tenant.timezone, day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).format(new Date(iso)).replace(", ", " às ");
  }

  function hhmm(iso) {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: tenant.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).format(new Date(iso));
  }

  const initial = name => (name || "?").trim().charAt(0).toUpperCase();

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

  // uma renovação por vez: duas chamadas simultâneas não invalidam o refresh token
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
    if (!res.ok) throw new Error((data && (data.message || data.hint)) || "api_error");
    return data;
  }

  /* ---------------- login ---------------- */
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
      const msg = /invalid|credential|grant/i.test(err.message)
        ? "E-mail ou senha incorretos."
        : "Não consegui entrar agora. Tente de novo.";
      showLogin(msg);
    }
  });

  async function logout() {
    try {
      if (session) await authRequest("logout", null, session.access_token);
    } catch (e) { /* sessão já pode ter expirado */ }
    clearSession();
    memberships = [];
    tenant = null;
    clientsCache = null;
    showLogin("");
    loginForm.reset();
  }

  /* ---------------- início do app ---------------- */
  async function start() {
    if (!user) user = await getMe();

    memberships = await api("memberships?select=tenant_id,role,tenants(id,slug,name,timezone,whatsapp)");
    if (!memberships || !memberships.length) {
      clearSession();
      showLogin("Esta conta ainda não está ligada a um lava-jato. Peça o acesso ao administrador.");
      return;
    }

    const switcher = $("#tenantSwitch");
    if (memberships.length > 1) {
      switcher.innerHTML = memberships.map((m, i) =>
        `<option value="${i}">${esc(m.tenants.name)}</option>`).join("");
      switcher.hidden = false;
      switcher.onchange = () => selectTenant(Number(switcher.value));
    }

    await selectTenant(0);
    showApp();
  }

  async function selectTenant(index) {
    const m = memberships[index];
    if (!m) return;

    tenant = { ...m.tenants, id: m.tenant_id };
    tenant.role = m.role;
    clientsCache = null;
    catalog = null;
    svcEditor = { loaded: false, services: [], prices: [], vehicles: [] };
    svcCategorySupported = true;
    boxes = [];
    bkDay = { date: null, bookings: [], blocks: [] };

    $("#tenantName").textContent = tenant.name;
    $("#brandMark").textContent = initial(tenant.name);
    $("#loginMark").textContent = initial(tenant.name);
    $("#userEmail").textContent = (user && user.email) || session.email || "";
    $("#tenantWhats").value = tenant.whatsapp || "";
    document.title = tenant.name + " · Painel";

    hours = {};
    try {
      const rows = await api(`business_hours?tenant_id=eq.${tenant.id}&select=weekday,opens_at,closes_at,closed&order=weekday`);
      for (const r of rows) hours[r.weekday] = r;
    } catch (e) { /* agenda ainda funciona sem os horários */ }

    try { await loadBoxes(); } catch (e) { /* migração pendente */ }

    currentDay = todayInTz();
    $("#dayInput").value = currentDay;

    switchTab("agenda");
  }

  /* ---------------- abas ---------------- */
  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll(".tabs button").forEach(b => {
      const on = b.dataset.tab === tab;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });

    $("#tab-agenda").hidden = tab !== "agenda";
    $("#tab-clientes").hidden = tab !== "clientes";
    $("#tab-resumo").hidden = tab !== "resumo";
    $("#tab-ajustes").hidden = tab !== "ajustes";

    if (tab === "agenda") renderAgenda();
    if (tab === "clientes") renderClients();
    if (tab === "resumo") renderSummary();
    if (tab === "ajustes") {
      renderBoxes();
      if (!svcEditor.loaded) {
        $("#serviceList").innerHTML = `<div class="empty">Carregando serviços...</div>`;
      }
      loadServiceEditor()
        .then(renderServicesAdmin)
        .catch(err => {
          $("#serviceList").innerHTML =
            `<div class="empty">Não consegui carregar os serviços: ${esc(err.message)}</div>`;
        });
    }
  }

  document.querySelectorAll(".tabs button").forEach(b => {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  });

  /* ---------------- agenda ---------------- */
  const agendaList = $("#agendaList");

  function dayRange(dateStr) {
    const from = zonedToUtc(dateStr, "00:00", tenant.timezone);
    const to = zonedToUtc(addDays(dateStr, 1), "00:00", tenant.timezone);
    return [from.toISOString(), to.toISOString()];
  }

  async function fetchBookings(fromISO, toISO, extra = "") {
    return api(`bookings?tenant_id=eq.${tenant.id}`
      + `&starts_at=gte.${encodeURIComponent(fromISO)}`
      + `&starts_at=lt.${encodeURIComponent(toISO)}`
      + `&select=${BOOKING_FIELDS}`
      + `&order=starts_at.asc${extra}`);
  }

  async function fetchBlocks(fromISO, toISO) {
    try {
      return await api(`time_blocks?tenant_id=eq.${tenant.id}`
        + `&starts_at=gte.${encodeURIComponent(fromISO)}`
        + `&starts_at=lt.${encodeURIComponent(toISO)}`
        + `&select=id,starts_at,ends_at,reason&order=starts_at.asc`);
    } catch (e) {
      return []; // migração de bloqueios ainda não aplicada
    }
  }

  async function renderAgenda() {
    if (!tenant) return;

    $("#dayTitle").textContent = fmtDateLong(currentDay);
    $("#daySummary").textContent = "Carregando…";
    agendaList.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';

    let rows = [], blocks = [];
    try {
      const [from, to] = dayRange(currentDay);
      [rows, blocks] = await Promise.all([fetchBookings(from, to), fetchBlocks(from, to)]);
    } catch (err) {
      agendaList.innerHTML = `<div class="empty"><b>Não consegui carregar a agenda</b>${esc(err.message)}</div>`;
      $("#daySummary").textContent = "";
      return;
    }

    agendaRows = rows;

    const showCancelled = $("#showCancelled").checked;
    const visible = rows.filter(b => showCancelled || b.status !== "cancelled");
    const active = rows.filter(b => b.status !== "cancelled");
    const revenue = active
      .filter(b => ["pending", "confirmed", "done"].includes(b.status))
      .reduce((sum, b) => sum + b.price_cents, 0);
    const done = active.filter(b => b.status === "done").length;

    const items = [
      ...visible.map(b => ({ t: b.starts_at, html: bookingRow(b) })),
      ...blocks.map(b => ({ t: b.starts_at, html: blockRow(b) }))
    ].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));

    const parts = [
      `${active.length} ${active.length === 1 ? "agendamento" : "agendamentos"}`,
      `${money(revenue)} previstos`
    ];
    if (done) parts.push(`${done} concluído${done > 1 ? "s" : ""}`);
    if (blocks.length) parts.push(`${blocks.length} bloqueio${blocks.length > 1 ? "s" : ""}`);
    $("#daySummary").textContent = parts.join(" · ");

    if (!items.length) {
      agendaList.innerHTML = `<div class="empty"><b>Nenhum agendamento neste dia</b>
        ${rows.length && !showCancelled ? "Só há cancelados — marque “Cancelados” para ver." : "Crie um encaixe ou aguarde um agendamento pela página."}
        <div><button type="button" class="btn" data-new>+ Novo agendamento</button></div>
      </div>`;
      return;
    }

    agendaList.innerHTML = items.map(i => i.html).join("");
  }

  function blockRow(b) {
    return `
      <div class="booking block">
        <div class="b-time"><b>${hhmm(b.starts_at)}</b><small>${hhmm(b.ends_at)}</small></div>
        <div class="b-main">
          <b>Horário bloqueado</b>
          <span class="b-detail">${esc(b.reason || "Sem motivo informado")}</span>
        </div>
        <div class="b-price"></div>
        <div class="b-side">
          <span class="pill blocked">Bloqueado</span>
          <div class="b-actions">
            <button type="button" class="btn-sm danger" data-unblock="${b.id}">Remover</button>
          </div>
        </div>
      </div>`;
  }

  function bookingRow(b) {
    const st = STATUS[b.status] || STATUS.confirmed;
    const c = b.customer || {};
    const phone = c.phone ? `<a href="https://wa.me/${waPhone(c.phone)}" target="_blank" rel="noopener">${esc(fmtPhone(c.phone))}</a>` : "";
    const service = [
      b.service && b.service.name,
      b.vehicle && b.vehicle.name,
      b.box && b.box.name
    ].filter(Boolean).join(" · ");

    return `
      <div class="booking ${st.cls}">
        <div class="b-time"><b>${hhmm(b.starts_at)}</b><small>${hhmm(b.ends_at)}</small></div>
        <div class="b-main">
          <b>${esc(c.name || "Cliente")}</b>${phone}
          <span class="b-detail">${esc(service || "Serviço")}</span>
          <span class="b-code">${esc(b.code)}</span>
        </div>
        <div class="b-price">${money(b.price_cents)}</div>
        <div class="b-side">
          <span class="pill ${st.cls}">${st.label}</span>
          <div class="b-actions">${bookingActions(b)}</div>
        </div>
      </div>`;
  }

  function bookingActions(b) {
    const btn = (status, label, cls) =>
      `<button type="button" class="btn-sm ${cls}" data-id="${b.id}" data-status="${status}">${label}</button>`;

    const edit = `<button type="button" class="btn-sm" data-edit="${b.id}">Remarcar</button>`;

    if (b.status === "pending") {
      return btn("confirmed", "Confirmar", "ok") + edit + btn("cancelled", "Cancelar", "danger");
    }
    if (b.status === "confirmed") {
      return btn("done", "Concluir", "ok")
        + edit
        + btn("no_show", "Faltou", "")
        + btn("cancelled", "Cancelar", "danger");
    }
    if (b.status === "done") {
      return btn("confirmed", "Reabrir", "");
    }
    if (b.status === "cancelled" || b.status === "no_show") {
      return btn("confirmed", "Reabrir", "");
    }
    return "";
  }

  agendaList.addEventListener("click", async e => {
    const addBtn = e.target.closest("[data-new]");
    if (addBtn) { openNewBooking(); return; }

    const unblock = e.target.closest("[data-unblock]");
    if (unblock) {
      if (!confirm("Remover este bloqueio? O horário volta a ficar livre.")) return;
      unblock.disabled = true;
      try {
        await api(`time_blocks?id=eq.${unblock.dataset.unblock}`, { method: "DELETE" });
        toast("Bloqueio removido.");
        bkDay = { date: null, bookings: [], blocks: [] };
        renderAgenda();
      } catch (err) {
        unblock.disabled = false;
        toast("Não consegui remover: " + err.message, true);
      }
      return;
    }

    const editBtn = e.target.closest("[data-edit]");
    if (editBtn) {
      const b = agendaRows.find(x => x.id === editBtn.dataset.edit);
      if (b) openEditBooking(b);
      return;
    }

    const btn = e.target.closest("[data-status]");
    if (!btn) return;

    const status = btn.dataset.status;
    const id = btn.dataset.id;

    if (status === "cancelled" && !confirm("Cancelar este agendamento? O horário volta a ficar livre.")) return;
    if (status === "no_show" && !confirm("Marcar como falta (o cliente não veio)?")) return;

    btn.disabled = true;
    try {
      await api(`bookings?id=eq.${id}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ status })
      });
      toast("Agendamento atualizado.");
      bkDay = { date: null, bookings: [], blocks: [] };
      renderAgenda();
      clientsCache = null;
    } catch (err) {
      btn.disabled = false;
      toast(/overlap|exclusion/i.test(err.message)
        ? "Esse horário já está ocupado por outro agendamento."
        : "Não consegui atualizar: " + err.message, true);
    }
  });

  $("#prevDay").addEventListener("click", () => setDay(addDays(currentDay, -1)));
  $("#nextDay").addEventListener("click", () => setDay(addDays(currentDay, 1)));
  $("#todayBtn").addEventListener("click", () => {
    currentDay = todayInTz();
    $("#dayInput").value = currentDay;
    renderAgenda();
  });
  $("#dayInput").addEventListener("change", e => {
    if (e.target.value) setDay(e.target.value);
  });
  $("#showCancelled").addEventListener("change", renderAgenda);
  $("#refreshBtn").addEventListener("click", renderAgenda);
  $("#newBookingBtn").addEventListener("click", openNewBooking);
  $("#blockBtn").addEventListener("click", () => openBlockModal(currentDay));
  $("#closeDayBtn").addEventListener("click", () => openCloseDay(currentDay));

  function setDay(dateStr) {
    currentDay = dateStr;
    $("#dayInput").value = dateStr;
    renderAgenda();
  }

  /* ---------------- clientes ---------------- */
  const clientList = $("#clientList");

  async function loadClients(force) {
    if (clientsCache && !force) return clientsCache;
    const rows = await api(`customers?tenant_id=eq.${tenant.id}`
      + `&select=id,name,phone,plate,notes,created_at,bookings(starts_at,status,price_cents,service:services(name))`
      + `&order=name.asc`);

    clientsCache = rows.map(c => {
      const bookings = (c.bookings || []).slice().sort((a, b) => (a.starts_at < b.starts_at ? 1 : -1));
      const done = bookings.filter(b => b.status === "done");
      const shown = bookings.filter(b => ["pending", "confirmed", "done"].includes(b.status));
      return {
        ...c,
        bookings,
        visits: done.length,
        last: shown.length ? shown[0].starts_at : null,
        spent: done.reduce((s, b) => s + b.price_cents, 0)
      };
    });

    clientsCache.sort((a, b) => {
      if (a.last && b.last) return a.last < b.last ? 1 : -1;
      if (a.last) return -1;
      if (b.last) return 1;
      return a.name.localeCompare(b.name, "pt-BR");
    });

    return clientsCache;
  }

  async function renderClients(force) {
    if (!tenant) return;
    $("#clientCount").textContent = "";
    clientList.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';

    let rows = [];
    try {
      rows = await loadClients(force);
    } catch (err) {
      clientList.innerHTML = `<div class="empty"><b>Não consegui carregar os clientes</b>${esc(err.message)}</div>`;
      return;
    }

    applyClientFilter(rows);
  }

  function applyClientFilter(rows) {
    const q = $("#clientSearch").value.trim().toLowerCase();
    const digits = q.replace(/\D/g, "");

    const filtered = !q ? rows : rows.filter(c =>
      c.name.toLowerCase().includes(q) || (digits && String(c.phone || "").includes(digits))
    );

    $("#clientCount").textContent = `${filtered.length} ${filtered.length === 1 ? "cliente" : "clientes"}`;

    if (!filtered.length) {
      clientList.innerHTML = `<div class="empty"><b>Nenhum cliente encontrado</b>${rows.length ? "Tente outro nome ou telefone." : "Os clientes aparecem aqui quando agendam pela página."}</div>`;
      return;
    }

    clientList.innerHTML = `<div class="client-row head" aria-hidden="true">
        <span>Cliente</span><span>Visitas</span><span>Último</span><span>Total</span>
      </div>` + filtered.map(c => `
      <div class="client-row" data-client="${c.id}" tabindex="0" role="button" aria-label="Ver ${esc(c.name)}">
        <div>
          <div class="c-name">${esc(c.name)}</div>
          <div class="c-phone">${esc(fmtPhone(c.phone) || "sem telefone")}</div>
        </div>
        <div class="c-meta"><b>${c.visits}</b> ${c.visits === 1 ? "visita" : "visitas"}</div>
        <div class="c-meta">${c.last ? fmtDateShort(c.last) : "—"}</div>
        <div class="c-spent">${money(c.spent)}</div>
      </div>`).join("");

    clientList.querySelectorAll("[data-client]").forEach(el => {
      const open = () => openClient(el.dataset.client);
      el.addEventListener("click", open);
      el.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
    });
  }

  $("#clientSearch").addEventListener("input", () => {
    if (clientsCache) applyClientFilter(clientsCache);
  });

  /* ---------------- modal do cliente ---------------- */
  const modal = $("#clientModal");
  const customerModal = $("#customerModal");
  const customerForm = $("#customerForm");

  function openClient(id) {
    const c = (clientsCache || []).find(x => x.id === id);
    if (!c) return;
    activeClient = c;

    $("#clientModalName").textContent = c.name;
    const phone = c.phone
      ? `<a href="https://wa.me/${waPhone(c.phone)}" target="_blank" rel="noopener">${esc(fmtPhone(c.phone))}</a>`
      : "sem telefone";
    const facts = [];
    if (c.plate) facts.push(`Placa ${esc(c.plate)}`);
    if (c.notes) facts.push(esc(c.notes));
    $("#clientModalMeta").innerHTML = `${phone} · ${c.visits} ${c.visits === 1 ? "visita" : "visitas"} · ${money(c.spent)}`
      + (facts.length ? `<span class="client-facts">${facts.join(" · ")}</span>` : "");

    const list = (c.bookings || []).filter(b => b.status !== "cancelled");
    $("#clientModalBody").innerHTML = list.length
      ? list.map(b => {
          const st = STATUS[b.status] || STATUS.confirmed;
          return `<div class="mini-item">
            <span class="m-time">${fmtDateShort(b.starts_at)}</span>
            <span class="m-main">
              <b>${esc((b.service && b.service.name) || "Serviço")}</b>
              <small><span class="pill ${st.cls}">${st.label}</span> · ${hhmm(b.starts_at)}</small>
            </span>
            <span class="m-price">${money(b.price_cents)}</span>
          </div>`;
        }).join("")
      : `<div class="empty">Nenhum agendamento ainda.</div>`;

    modal.hidden = false;
  }

  function closeModal() {
    modal.hidden = true;
    activeClient = null;
  }

  function showCustomerError(message) {
    const el = $("#cuError");
    el.textContent = message;
    el.hidden = !message;
  }

  function openCustomerEditor(c) {
    if (!c) return;
    modal.hidden = true;
    $("#cuId").value = c.id;
    $("#cuName").value = c.name || "";
    $("#cuPhone").value = c.phone || "";
    $("#cuPlate").value = c.plate || "";
    $("#cuNotes").value = c.notes || "";
    showCustomerError("");
    customerModal.hidden = false;
    $("#cuName").focus();
    $("#cuName").select();
  }

  function closeCustomerEditor() {
    customerModal.hidden = true;
    if (activeClient) modal.hidden = false;
  }

  async function deleteClient() {
    const c = activeClient;
    if (!c) return;

    const bookings = c.bookings || [];
    const upcoming = bookings.filter(b =>
      ["pending", "confirmed"].includes(b.status) && Date.parse(b.starts_at) >= Date.now());
    let message = `Excluir o contato "${c.name}"?`;
    if (bookings.length) {
      message += `\n\n${bookings.length} agendamento${bookings.length === 1 ? "" : "s"} `
        + "continuará" + (bookings.length === 1 ? "" : "ão")
        + " no histórico, mas sem nome e telefone.";
    }
    if (upcoming.length) {
      message += `\n\nAtenção: há ${upcoming.length} agendamento${upcoming.length === 1 ? "" : "s"} `
        + "futuro" + (upcoming.length === 1 ? "" : "s") + " que continuará"
        + (upcoming.length === 1 ? "" : "ão") + " na agenda sem o contato.";
    }
    if (!confirm(message)) return;

    const btn = $("#clientDelete");
    btn.disabled = true;
    btn.textContent = "Excluindo…";
    try {
      await api(`customers?id=eq.${c.id}`, {
        method: "DELETE",
        headers: { Prefer: "return=minimal" }
      });
      activeClient = null;
      modal.hidden = true;
      clientsCache = null;
      await renderClients(true);
      toast("Contato excluído.");
    } catch (err) {
      toast("Não consegui excluir o contato: " + err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Excluir contato";
    }
  }

  customerForm.addEventListener("submit", async e => {
    e.preventDefault();
    const id = $("#cuId").value;
    const c = (clientsCache || []).find(x => x.id === id);
    if (!c) return closeAllModals();

    const name = $("#cuName").value.trim();
    const phone = onlyDigits($("#cuPhone").value);
    const plate = $("#cuPlate").value.trim().toUpperCase();
    const notes = $("#cuNotes").value.trim();

    if (!name) return showCustomerError("Informe o nome do cliente.");
    if (phone && (phone.length < 10 || phone.length > 13)) {
      return showCustomerError("WhatsApp inválido. Use DDD + número.");
    }

    const btn = $("#cuSave");
    btn.disabled = true;
    btn.textContent = "Salvando…";
    showCustomerError("");
    try {
      await api(`customers?id=eq.${id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          name,
          phone: phone || null,
          plate: plate || null,
          notes: notes || null
        })
      });
      customerModal.hidden = true;
      clientsCache = null;
      await renderClients(true);
      const fresh = (clientsCache || []).find(x => x.id === id);
      if (fresh) openClient(fresh.id);
      toast("Contato atualizado.");
    } catch (err) {
      showCustomerError("Não consegui salvar: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Salvar";
    }
  });

  $("#clientModalClose").addEventListener("click", closeModal);
  modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
  $("#clientEdit").addEventListener("click", () => openCustomerEditor(activeClient));
  $("#clientDelete").addEventListener("click", deleteClient);
  $("#customerModalClose").addEventListener("click", closeCustomerEditor);
  $("#cuCancel").addEventListener("click", closeCustomerEditor);
  customerModal.addEventListener("click", e => { if (e.target === customerModal) closeCustomerEditor(); });

  /* =========================================================
     BOXES
     ========================================================= */
  async function loadBoxes(force) {
    if (!force && boxes.length) return boxes;
    boxes = await api(`boxes?tenant_id=eq.${tenant.id}&active=eq.true`
      + `&select=id,name,sort_order&order=sort_order,name`);
    return boxes;
  }

  function renderBoxes() {
    const list = $("#boxList");
    if (!list) return;

    list.innerHTML = boxes.length
      ? boxes.map(b => `
        <div class="box-row" data-box="${b.id}">
          <span class="box-dot" aria-hidden="true"></span>
          <input class="box-name" data-box-name value="${esc(b.name)}" maxlength="30" aria-label="Nome do box">
          <button type="button" class="btn-sm" data-box-save>Salvar</button>
          <button type="button" class="btn-sm danger" data-box-remove>Remover</button>
        </div>`).join("")
      : `<div class="empty">Nenhum box ativo. Adicione pelo menos um.</div>`;
  }

  function fillBoxSelect(selected) {
    const sel = $("#bkBox");
    if (!sel) return;
    sel.innerHTML = '<option value="">Automático</option>'
      + boxes.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join("");
    sel.value = selected || "";
  }

  $("#boxForm").addEventListener("submit", async e => {
    e.preventDefault();
    const name = $("#boxName").value.trim();
    if (!name) return;

    const sort = boxes.reduce((m, b) => Math.max(m, b.sort_order || 0), 0) + 1;
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await api("boxes", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ tenant_id: tenant.id, name, sort_order: sort })
      });
      $("#boxName").value = "";
      await loadBoxes(true);
      renderBoxes();
      fillBoxSelect();
      toast("Box adicionado.");
    } catch (err) {
      toast(/duplicate|unique/i.test(err.message)
        ? "Já existe um box com esse nome."
        : "Não consegui adicionar: " + err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  $("#boxList").addEventListener("click", async e => {
    const row = e.target.closest("[data-box]");
    if (!row) return;
    const id = row.dataset.box;

    if (e.target.closest("[data-box-save]")) {
      const name = row.querySelector("[data-box-name]").value.trim();
      if (!name) { toast("Dê um nome ao box.", true); return; }
      try {
        await api(`boxes?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
        await loadBoxes(true);
        renderBoxes();
        fillBoxSelect();
        toast("Box atualizado.");
      } catch (err) {
        toast(/duplicate|unique/i.test(err.message)
          ? "Já existe um box com esse nome."
          : "Não consegui salvar: " + err.message, true);
      }
      return;
    }

    if (e.target.closest("[data-box-remove]")) {
      if (boxes.length <= 1) {
        toast("O lava-jato precisa de pelo menos um box.", true);
        return;
      }
      try {
        const nowIso = new Date().toISOString();
        const future = await api(`bookings?tenant_id=eq.${tenant.id}`
          + `&box_id=eq.${id}&ends_at=gte.${encodeURIComponent(nowIso)}`
          + `&status=in.(pending,confirmed)&select=id&limit=1`);
        if (future.length) {
          toast("Mova os agendamentos futuros desse box antes de removê-lo.", true);
          return;
        }
      } catch (err) {
        toast("Não consegui verificar os agendamentos: " + err.message, true);
        return;
      }
      if (!confirm("Remover este box? O histórico continua guardado.")) return;

      try {
        await api(`boxes?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ active: false }) });
        await loadBoxes(true);
        renderBoxes();
        fillBoxSelect();
        toast("Box removido.");
      } catch (err) {
        toast("Não consegui remover: " + err.message, true);
      }
    }
  });

  $("#whatsForm").addEventListener("submit", async e => {
    e.preventDefault();
    const digits = onlyDigits($("#tenantWhats").value);
    if (digits.length < 10 || digits.length > 13) {
      toast("WhatsApp inválido. Use DDD + número.", true);
      return;
    }
    try {
      await api(`tenants?id=eq.${tenant.id}`, {
        method: "PATCH",
        body: JSON.stringify({ whatsapp: digits })
      });
      tenant.whatsapp = digits;
      $("#tenantWhats").value = digits;
      toast("WhatsApp salvo.");
    } catch (err) {
      toast("Não consegui salvar: " + err.message, true);
    }
  });

  /* =========================================================
     CATÁLOGO (serviços, preços e veículos)
     ========================================================= */
  async function loadCatalog() {
    if (catalog) return catalog;

    const [rows, vehicles] = await Promise.all([
      api(`public_services?tenant_slug=eq.${encodeURIComponent(tenant.slug)}`
        + `&select=service_id,name,description,minutes,vehicle_id,price_cents,duration_minutes,sort_order`
        + `&order=sort_order`),
      api("vehicles?select=id,name,hint,time_factor&order=sort_order")
    ]);

    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.service_id)) {
        map.set(r.service_id, {
          id: r.service_id, name: r.name, description: r.description,
          minutes: r.minutes, prices: {}
        });
      }
      map.get(r.service_id).prices[r.vehicle_id] = {
        cents: r.price_cents,
        minutes: r.duration_minutes || r.minutes
      };
    }

    catalog = { services: [...map.values()], vehicles };
    return catalog;
  }

  const vehicleName = id => {
    const list = (catalog && catalog.vehicles) || svcEditor.vehicles || [];
    const v = list.find(x => x.id === id);
    return v ? v.name : (id || "Veículo");
  };

  /* =========================================================
     SERVIÇOS (catálogo editável pelo dono)
     ========================================================= */
  function serviceComputedMinutes(base, factor) {
    const total = (Number(base) || 0) * (Number(factor) || 1);
    if (total <= 0) return 0;
    return total >= 60 ? Math.round(total / 15) * 15 : Math.round(total / 5) * 5;
  }

  function serviceCentsInput(cents) {
    return (Number(cents || 0) / 100).toFixed(2).replace(".", ",");
  }

  function parseServicePrice(raw) {
    let s = String(raw || "").trim();
    if (!s) return { empty: true };
    if (s.includes("-")) return { error: true };
    s = s.replace(/[^\d.,]/g, "");
    if (!s) return { error: true };
    if (s.includes(",")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      const parts = s.split(".");
      if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
        s = s.replace(/\./g, "");
      }
    }
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return { error: true };
    if (n === 0) return { empty: true };
    return { cents: Math.round(n * 100) };
  }

  function showServiceError(message) {
    const el = $("#svError");
    el.textContent = message;
    el.hidden = false;
  }

  async function loadServiceEditor(force) {
    if (svcEditor.loaded && !force) return svcEditor;

    const base = `services?tenant_id=eq.${tenant.id}`
      + `&select=id,name,description,minutes,sort_order,active`;
    const [prices, vehicles] = await Promise.all([
      api(`service_prices?tenant_id=eq.${tenant.id}`
        + `&select=service_id,vehicle_id,price_cents,minutes_override`),
      api("vehicles?select=id,name,hint,time_factor&order=sort_order")
    ]);

    let services;
    if (svcCategorySupported) {
      try {
        services = await api(base + ",category&order=sort_order,name");
      } catch (err) {
        // painel pode rodar antes da migração que cria services.category
        if (!/category|column/i.test(err.message)) throw err;
        svcCategorySupported = false;
        services = await api(base + "&order=sort_order,name");
      }
    } else {
      services = await api(base + "&order=sort_order,name");
    }

    svcEditor = {
      loaded: true,
      services: services || [],
      prices: prices || [],
      vehicles: vehicles || []
    };
    return svcEditor;
  }

  function renderServicesAdmin() {
    const list = $("#serviceList");
    if (!list) return;

    if (!svcEditor.loaded) {
      list.innerHTML = `<div class="empty">Carregando serviços...</div>`;
      return;
    }

    if (!svcEditor.services.length) {
      list.innerHTML = `<div class="empty"><b>Nenhum serviço cadastrado</b>
        Cadastre o primeiro serviço para ele aparecer no site.
        <div><button type="button" class="btn" data-svc-new>+ Novo serviço</button></div>
      </div>`;
      return;
    }

    list.innerHTML = svcEditor.services.map(s => {
      const prices = svcEditor.prices
        .filter(p => p.service_id === s.id)
        .map(p => p.price_cents)
        .filter(c => c > 0);
      const min = prices.length ? Math.min(...prices) : 0;
      const max = prices.length ? Math.max(...prices) : 0;
      const range = !prices.length
        ? "Sem preço"
        : (min === max ? money(min) : `${money(min)}–${money(max)}`);

      return `
        <div class="service-row ${s.active ? "" : "archived"}" data-service="${s.id}">
          <div class="s-main">
            <b>${esc(s.name)}</b>
            <div class="s-tags">
              ${s.category ? `<span class="svc-cat-badge">${esc(s.category)}</span>` : ""}
              <span class="svc-state ${s.active ? "" : "off"}">${s.active ? "Ativo" : "Arquivado"}</span>
            </div>
            <small>${esc(s.description || "Sem descrição")}</small>
          </div>
          <div class="s-meta">
            <b>${range}</b>
            <small>${s.minutes} min base</small>
          </div>
          <div class="s-actions">
            <button type="button" class="btn-sm" data-svc-edit>Editar</button>
            <button type="button" class="btn-sm ${s.active ? "danger" : ""}" data-svc-toggle>${s.active ? "Arquivar" : "Reativar"}</button>
          </div>
        </div>`;
    }).join("");
  }

  function renderServicePriceRows(service) {
    const base = Number($("#svMinutes").value) || 0;
    $("#svPrices").innerHTML = svcEditor.vehicles.map(v => {
      const price = service
        ? svcEditor.prices.find(p => p.service_id === service.id && p.vehicle_id === v.id)
        : null;
      const computed = serviceComputedMinutes(base, v.time_factor);
      const priceValue = price ? serviceCentsInput(price.price_cents) : "";
      const durationValue = price && price.minutes_override ? price.minutes_override : "";
      return `
        <div class="price-row" data-vehicle="${esc(v.id)}">
          <div class="v-name">
            <b>${esc(v.name)}</b>
            <small>${esc(v.hint || "")}</small>
          </div>
          <label>
            <span>Preço</span>
            <input data-price inputmode="decimal" placeholder="0,00" value="${priceValue}" aria-label="Preço ${esc(v.name)}">
          </label>
          <label>
            <span>Duração</span>
            <input data-duration type="number" min="0" step="5" placeholder="${computed}" value="${durationValue}" aria-label="Duração ${esc(v.name)}">
          </label>
        </div>`;
    }).join("");
  }

  function refreshServiceDurations() {
    const base = Number($("#svMinutes").value) || 0;
    $("#svPrices").querySelectorAll(".price-row").forEach(row => {
      const vehicle = svcEditor.vehicles.find(v => v.id === row.dataset.vehicle);
      const input = row.querySelector("[data-duration]");
      if (vehicle && input) input.placeholder = String(serviceComputedMinutes(base, vehicle.time_factor));
    });
  }

  async function openServiceModal(service) {
    try {
      await loadServiceEditor();
    } catch (err) {
      toast("Não consegui carregar os serviços: " + err.message, true);
      return;
    }
    if (!svcEditor.vehicles.length) {
      toast("Nenhum tipo de veículo cadastrado.", true);
      return;
    }

    closeAllModals();
    serviceForm.reset();

    const isEdit = !!service;
    $("#svId").value = isEdit ? service.id : "";
    $("#serviceTitle").textContent = isEdit ? "Editar serviço" : "Novo serviço";
    $("#serviceSub").textContent = isEdit
      ? "As mudanças valem para os próximos agendamentos."
      : "O serviço aparece no site assim que tiver pelo menos um preço.";
    $("#svName").value = isEdit ? service.name : "";
    $("#svCategory").value = isEdit && service.category ? service.category : "";
    $("#svDescription").value = isEdit ? (service.description || "") : "";
    $("#svMinutes").value = isEdit ? service.minutes : 30;
    $("#svOrder").value = isEdit
      ? service.sort_order
      : Math.max(0, ...svcEditor.services.map(s => Number(s.sort_order) || 0)) + 1;
    $("#svActive").value = isEdit && !service.active ? "false" : "true";
    $("#svError").hidden = true;
    $("#svCategoryField").hidden = !svcCategorySupported;
    renderServicePriceRows(isEdit ? service : null);
    $("#svSave").disabled = false;
    $("#svSave").textContent = "Salvar";
    serviceModal.hidden = false;
    setTimeout(() => $("#svName").focus(), 20);
  }

  async function saveService(e) {
    e.preventDefault();

    const serviceId = $("#svId").value;
    const isEdit = !!serviceId;
    const name = $("#svName").value.trim();
    const category = svcCategorySupported ? $("#svCategory").value.trim() : "";
    const description = $("#svDescription").value.trim();
    const minutes = Number($("#svMinutes").value);
    const order = Number($("#svOrder").value);
    const active = $("#svActive").value !== "false";

    if (!name) return showServiceError("Informe o nome do serviço.");
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return showServiceError("Informe uma duração base válida.");
    }
    if (!Number.isFinite(order) || order < 0) {
      return showServiceError("A ordem precisa ser zero ou maior.");
    }

    const rows = [];
    let hasPrice = false;
    for (const row of $("#svPrices").querySelectorAll(".price-row")) {
      const vehicleId = row.dataset.vehicle;
      const parsed = parseServicePrice(row.querySelector("[data-price]").value);
      if (parsed.error) {
        return showServiceError(`Preço inválido para ${vehicleName(vehicleId)}.`);
      }
      if (parsed.empty) continue;

      hasPrice = true;
      const durationRaw = row.querySelector("[data-duration]").value.trim();
      let override = null;
      if (durationRaw) {
        const duration = Number(durationRaw);
        if (!Number.isFinite(duration) || duration < 0) {
          return showServiceError(`Duração inválida para ${vehicleName(vehicleId)}.`);
        }
        if (duration > 0) override = Math.round(duration);
      }
      rows.push({
        tenant_id: tenant.id,
        vehicle_id: vehicleId,
        price_cents: parsed.cents,
        minutes_override: override
      });
    }

    if (!hasPrice) {
      return showServiceError("Preencha o preço de pelo menos um veículo.");
    }

    const button = $("#svSave");
    button.disabled = true;
    button.textContent = "Salvando...";
    $("#svError").hidden = true;

    try {
      const payload = {
        name,
        description: description || null,
        minutes: Math.round(minutes),
        sort_order: Math.round(order),
        active
      };
      if (svcCategorySupported) payload.category = category || null;

      let id = serviceId;
      if (id) {
        await api(`services?id=eq.${id}`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(payload)
        });
      } else {
        const created = await api("services", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ ...payload, tenant_id: tenant.id })
        });
        id = created && created[0] && created[0].id;
        if (!id) throw new Error("o serviço não retornou id");
        $("#svId").value = id;
      }

      await api("service_prices?on_conflict=service_id,vehicle_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows.map(r => ({ ...r, service_id: id })))
      });

      const keep = new Set(rows.map(r => r.vehicle_id));
      const remove = svcEditor.prices
        .filter(p => p.service_id === id && !keep.has(p.vehicle_id))
        .map(p => p.vehicle_id);
      if (remove.length) {
        await api(`service_prices?service_id=eq.${id}&vehicle_id=in.(${remove.join(",")})`, {
          method: "DELETE"
        });
      }

      catalog = null;
      svcEditor.loaded = false;
      await loadServiceEditor(true);
      renderServicesAdmin();
      closeAllModals();
      toast(isEdit ? "Serviço atualizado." : "Serviço criado.");
    } catch (err) {
      showServiceError("Não consegui salvar: " + err.message);
    } finally {
      button.disabled = false;
      button.textContent = "Salvar";
    }
  }

  async function toggleServiceActive(service) {
    if (service.active && !confirm(`Arquivar "${service.name}"? Ele deixa de aparecer no site, mas o histórico fica.`)) {
      return;
    }
    try {
      await api(`services?id=eq.${service.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ active: !service.active })
      });
      catalog = null;
      svcEditor.loaded = false;
      await loadServiceEditor(true);
      renderServicesAdmin();
      toast(service.active ? "Serviço arquivado." : "Serviço reativado.");
    } catch (err) {
      toast("Não consegui alterar o serviço: " + err.message, true);
    }
  }

  /* =========================================================
     AGENDAMENTO (encaixe / remarcar)
     ========================================================= */
  const bookingModal = $("#bookingModal");
  const blockModal = $("#blockModal");
  const closeDayModal = $("#closeModal");
  const serviceModal = $("#serviceModal");
  const bookingForm = $("#bookingForm");
  const serviceForm = $("#serviceForm");

  function closeAllModals() {
    modal.hidden = true;
    customerModal.hidden = true;
    bookingModal.hidden = true;
    blockModal.hidden = true;
    closeDayModal.hidden = true;
    serviceModal.hidden = true;
    activeClient = null;
    editing = null;
  }

  function anyModalOpen() {
    return [modal, customerModal, bookingModal, blockModal, closeDayModal, serviceModal]
      .some(m => m && !m.hidden);
  }

  addEventListener("keydown", e => {
    if (e.key === "Escape" && anyModalOpen()) closeAllModals();
  });

  addEventListener("keydown", e => {
    if (currentTab !== "agenda" || anyModalOpen()) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (["input", "select", "textarea"].includes(tag)) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); setDay(addDays(currentDay, -1)); }
    if (e.key === "ArrowRight") { e.preventDefault(); setDay(addDays(currentDay, 1)); }
  });

  [bookingModal, blockModal, closeDayModal, serviceModal].forEach(m => {
    m.addEventListener("click", e => { if (e.target === m) closeAllModals(); });
  });

  $("#newServiceBtn").addEventListener("click", () => openServiceModal(null));
  $("#serviceList").addEventListener("click", e => {
    if (e.target.closest("[data-svc-new]")) {
      openServiceModal(null);
      return;
    }
    const row = e.target.closest("[data-service]");
    if (!row) return;
    const service = svcEditor.services.find(s => s.id === row.dataset.service);
    if (!service) return;
    if (e.target.closest("[data-svc-edit]")) openServiceModal(service);
    if (e.target.closest("[data-svc-toggle]")) toggleServiceActive(service);
  });
  $("#serviceModalClose").addEventListener("click", closeAllModals);
  $("#svCancel").addEventListener("click", closeAllModals);
  $("#svMinutes").addEventListener("input", refreshServiceDurations);
  serviceForm.addEventListener("submit", saveService);

  function toggleBookingFields(disabled) {
    ["#bkName", "#bkPhone", "#bkService", "#bkVehicle"].forEach(sel => {
      $(sel).disabled = disabled;
    });
  }

  function fillBookingSelects() {
    $("#bkService").innerHTML = catalog.services
      .map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
    $("#bkVehicle").innerHTML = catalog.vehicles
      .map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join("");
  }

  function findFormService() {
    const id = $("#bkService").value;
    const active = catalog.services.find(s => s.id === id);
    if (active) return active;
    if (!editing || !editing.service || editing.service.id !== id) return null;

    // Serviço arquivado (ou fora do catálogo) que ainda tem agendamento:
    // usa o preço e a duração gravados no próprio agendamento.
    const minutes = Math.round(
      (Date.parse(editing.ends_at) - Date.parse(editing.starts_at)) / 60000
    );
    return {
      id: editing.service.id,
      name: editing.service.name,
      minutes,
      prices: {
        [editing.vehicle_id]: { cents: editing.price_cents, minutes }
      }
    };
  }

  function ensureEditServiceOption(booking) {
    if (!booking.service) return;
    const select = $("#bkService");
    const exists = Array.from(select.options).some(o => o.value === booking.service.id);
    if (exists) return;
    const option = document.createElement("option");
    option.value = booking.service.id;
    option.textContent = `${booking.service.name} (fora do catálogo)`;
    select.appendChild(option);
  }

  function showBkError(message) {
    const el = $("#bkError");
    el.textContent = message;
    el.hidden = false;
  }

  async function openNewBooking() {
    editing = null;
    closeAllModals();
    bookingForm.reset();
    toggleBookingFields(false);
    $("#bookingTitle").textContent = "Novo agendamento";
    $("#bookingSub").textContent = "Encaixe ou agendamento feito no balcão.";
    $("#bkError").hidden = true;
    $("#bkSave").textContent = "Salvar";
    bookingModal.hidden = false;

    try {
      await Promise.all([loadCatalog(), loadBoxes()]);
    } catch (err) {
      bookingModal.hidden = true;
      toast("Não consegui carregar serviços: " + err.message, true);
      return;
    }

    if (!catalog.services.length) {
      bookingModal.hidden = true;
      toast("Nenhum serviço ativo. Cadastre serviços no banco.", true);
      return;
    }
    if (!boxes.length) {
      bookingModal.hidden = true;
      toast("Cadastre um box em Ajustes antes de agendar.", true);
      switchTab("ajustes");
      return;
    }

    fillBookingSelects();
    fillBoxSelect();
    $("#bkDate").value = currentDay || todayInTz();
    $("#bkNotes").value = "";
    bkDay = { date: null, bookings: [], blocks: [] };
    await refreshBookingForm();
    $("#bkName").focus();
  }

  async function openEditBooking(b) {
    closeAllModals();
    editing = b;
    bookingForm.reset();
    toggleBookingFields(false);
    $("#bookingTitle").textContent = "Remarcar agendamento";
    $("#bookingSub").textContent = "O serviço e o valor continuam os mesmos.";
    $("#bkError").hidden = true;
    $("#bkSave").textContent = "Salvar";
    bookingModal.hidden = false;

    try {
      await Promise.all([loadCatalog(), loadBoxes()]);
    } catch (err) {
      bookingModal.hidden = true;
      toast("Não consegui carregar os dados: " + err.message, true);
      return;
    }

    fillBookingSelects();
    ensureEditServiceOption(b);
    fillBoxSelect(boxes.some(x => x.id === b.box_id) ? b.box_id : "");
    $("#bkName").value = (b.customer && b.customer.name) || "";
    $("#bkPhone").value = (b.customer && b.customer.phone) || "";
    $("#bkService").value = b.service ? b.service.id : "";
    $("#bkVehicle").value = b.vehicle_id || "";
    $("#bkNotes").value = b.notes || "";
    $("#bkDate").value = localDay(b.starts_at);
    toggleBookingFields(true);
    bkDay = { date: null, bookings: [], blocks: [] };
    await refreshBookingForm(localHHMM(b.starts_at));
    $("#bkTime").focus();
  }

  async function loadBkDay(date) {
    if (bkDay.date === date) return bkDay;
    const [from, to] = dayRange(date);
    const [rows, blocks] = await Promise.all([
      api(`bookings?tenant_id=eq.${tenant.id}`
        + `&starts_at=gte.${encodeURIComponent(from)}`
        + `&starts_at=lt.${encodeURIComponent(to)}`
        + `&select=id,starts_at,ends_at,status,box_id`),
      fetchBlocks(from, to)
    ]);
    bkDay = { date, bookings: rows, blocks };
    return bkDay;
  }

  function findFreeBox(start, end, preferredId, data) {
    const s = start.getTime();
    const e = end.getTime();

    const blocked = (data.blocks || []).some(b =>
      overlaps(s, e, Date.parse(b.starts_at), Date.parse(b.ends_at)));
    if (blocked) return null;

    const busy = (data.bookings || []).filter(b =>
      ["pending", "confirmed", "done"].includes(b.status)
      && (!editing || b.id !== editing.id));

    const free = boxes.filter(box => !busy.some(b =>
      b.box_id === box.id && overlaps(s, e, Date.parse(b.starts_at), Date.parse(b.ends_at))));

    if (preferredId) return free.find(b => b.id === preferredId) || null;
    return free[0] || null;
  }

  async function refreshBookingForm(preferredTime) {
    if (bookingModal.hidden) return;
    const seq = ++bookingSeq;
    const timeSel = $("#bkTime");
    const hint = $("#bkHint");
    const errEl = $("#bkError");
    errEl.hidden = true;

    const date = $("#bkDate").value;
    const svc = findFormService();
    const vehicleId = $("#bkVehicle").value;
    const price = svc && svc.prices[vehicleId];
    const duration = editing
      ? Math.round((Date.parse(editing.ends_at) - Date.parse(editing.starts_at)) / 60000)
      : (price ? price.minutes : 0);

    if (!date) {
      hint.textContent = "Escolha o dia.";
      timeSel.innerHTML = "";
      return;
    }
    if (!svc || !duration) {
      hint.textContent = "Esse serviço não tem preço para o veículo escolhido.";
      timeSel.innerHTML = '<option value="">—</option>';
      return;
    }

    hint.textContent = `${svc.name} · ${vehicleName(vehicleId)} · ${duration} min · `
      + money(editing ? editing.price_cents : price.cents);

    const h = hours[weekdayOf(date)];
    if (!h || h.closed) {
      hint.textContent += " · fechado nesse dia";
      timeSel.innerHTML = '<option value="">—</option>';
      return;
    }

    let data;
    try {
      data = await loadBkDay(date);
    } catch (err) {
      hint.textContent = "Não consegui verificar os horários.";
      return;
    }
    if (seq !== bookingSeq) return;

    const [oh, om] = h.opens_at.split(":").map(Number);
    const [ch, cm] = h.closes_at.split(":").map(Number);
    const openM = oh * 60 + om;
    const closeM = ch * 60 + cm;
    const preferredBox = $("#bkBox").value || null;
    const opts = [];

    for (let m = openM; m + duration <= closeM; m += 15) {
      const hhmm = String(Math.floor(m / 60)).padStart(2, "0")
        + ":" + String(m % 60).padStart(2, "0");
      const start = zonedToUtc(date, hhmm, tenant.timezone);
      const end = new Date(start.getTime() + duration * 60000);
      if (findFreeBox(start, end, preferredBox, data)) opts.push(hhmm);
    }

    const current = preferredTime || timeSel.value;
    timeSel.innerHTML = opts.length
      ? opts.map(t => `<option value="${t}">${t}</option>`).join("")
      : '<option value="">Nenhum horário livre</option>';

    if (opts.length) {
      timeSel.value = opts.includes(current) ? current : opts[0];
      if (editing) {
        const original = localHHMM(editing.starts_at);
        if (opts.includes(original)) timeSel.value = original;
      }
    }
  }

  async function findOrCreateCustomer(name, phone) {
    if (phone) {
      const rows = await api(`customers?tenant_id=eq.${tenant.id}&select=id,name,phone`);
      const hit = rows.find(c => onlyDigits(c.phone) === phone);
      if (hit) return hit.id;
    }
    const [row] = await api("customers", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ tenant_id: tenant.id, name, phone: phone || null })
    });
    return row.id;
  }

  bookingForm.addEventListener("submit", async e => {
    e.preventDefault();
    const errEl = $("#bkError");
    errEl.hidden = true;

    const name = $("#bkName").value.trim();
    const phone = onlyDigits($("#bkPhone").value);
    const date = $("#bkDate").value;
    const hhmm = $("#bkTime").value;
    const notes = $("#bkNotes").value.trim();

    if (!name) return showBkError("Informe o nome do cliente.");
    if (!date || !hhmm) return showBkError("Escolha o dia e o horário.");

    const svc = findFormService();
    const vehicleId = $("#bkVehicle").value;
    const price = svc && svc.prices[vehicleId];
    const duration = editing
      ? Math.round((Date.parse(editing.ends_at) - Date.parse(editing.starts_at)) / 60000)
      : (price ? price.minutes : 0);

    if (!svc || (!editing && !price)) return showBkError("Serviço sem preço para esse veículo.");

    const start = zonedToUtc(date, hhmm, tenant.timezone);
    const end = new Date(start.getTime() + duration * 60000);
    const preferredBox = $("#bkBox").value || null;

    let day;
    try {
      day = await loadBkDay(date);
    } catch (err) {
      return showBkError("Não consegui verificar a agenda.");
    }

    const box = findFreeBox(start, end, preferredBox, day);
    if (!box) {
      showBkError("Esse horário acabou de ser ocupado. Escolha outro.");
      await refreshBookingForm();
      return;
    }

    const wasEditing = !!editing;
    const btn = $("#bkSave");
    btn.disabled = true;
    btn.textContent = "Salvando…";

    try {
      if (wasEditing) {
        await api(`bookings?id=eq.${editing.id}`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            starts_at: start.toISOString(),
            ends_at: end.toISOString(),
            box_id: box.id,
            notes: notes || null
          })
        });
        toast("Agendamento remarcado.");
      } else {
        const customerId = await findOrCreateCustomer(name, phone);
        await api("bookings", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            tenant_id: tenant.id,
            customer_id: customerId,
            service_id: svc.id,
            vehicle_id: vehicleId,
            box_id: box.id,
            starts_at: start.toISOString(),
            ends_at: end.toISOString(),
            price_cents: price.cents,
            status: "confirmed",
            notes: notes || null
          })
        });
        toast("Agendamento criado.");
      }

      bookingModal.hidden = true;
      editing = null;
      bkDay = { date: null, bookings: [], blocks: [] };
      clientsCache = null;

      if (currentDay !== date) setDay(date);
      else renderAgenda();
    } catch (err) {
      showBkError(/overlap|exclusion|bookings_no_overlap/i.test(err.message)
        ? "Esse horário já está ocupado. Escolha outro."
        : "Não consegui salvar: " + err.message);
      bkDay = { date: null, bookings: [], blocks: [] };
      await refreshBookingForm();
    } finally {
      btn.disabled = false;
      btn.textContent = "Salvar";
    }
  });

  ["#bkDate", "#bkService", "#bkVehicle", "#bkBox"].forEach(sel => {
    $(sel).addEventListener("change", () => refreshBookingForm());
  });

  $("#bookingClose").addEventListener("click", closeAllModals);
  $("#bkCancel").addEventListener("click", closeAllModals);

  /* =========================================================
     BLOQUEIO DE HORÁRIO
     ========================================================= */
  function openBlockModal(date) {
    closeAllModals();
    $("#blDate").value = date || currentDay || todayInTz();
    $("#blFrom").value = "12:00";
    $("#blTo").value = "13:00";
    $("#blReason").value = "";
    $("#blError").hidden = true;
    blockModal.hidden = false;
    $("#blFrom").focus();
  }

  $("#blockClose").addEventListener("click", closeAllModals);
  $("#blCancel").addEventListener("click", closeAllModals);

  $("#blockForm").addEventListener("submit", async e => {
    e.preventDefault();
    const errEl = $("#blError");
    errEl.hidden = true;

    const date = $("#blDate").value;
    const from = $("#blFrom").value;
    const to = $("#blTo").value;

    if (!date || !from || !to || to <= from) {
      errEl.textContent = "Confira o dia e o intervalo.";
      errEl.hidden = false;
      return;
    }

    const start = zonedToUtc(date, from, tenant.timezone);
    const end = zonedToUtc(date, to, tenant.timezone);

    let day = null;
    try { day = await loadBkDay(date); } catch (err) { /* segue sem a checagem */ }

    const conflict = day && (day.bookings || []).some(b =>
      ["pending", "confirmed", "done"].includes(b.status)
      && overlaps(start.getTime(), end.getTime(), Date.parse(b.starts_at), Date.parse(b.ends_at)));

    if (conflict && !confirm("Já existe agendamento nesse intervalo. Bloquear mesmo assim?")) return;

    const btn = $("#blSave");
    btn.disabled = true;
    btn.textContent = "Bloqueando…";

    try {
      await api("time_blocks", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          tenant_id: tenant.id,
          starts_at: start.toISOString(),
          ends_at: end.toISOString(),
          reason: $("#blReason").value.trim() || null
        })
      });
      toast("Horário bloqueado.");
      blockModal.hidden = true;
      bkDay = { date: null, bookings: [], blocks: [] };

      if (currentDay !== date) setDay(date);
      else renderAgenda();
    } catch (err) {
      errEl.textContent = "Não consegui bloquear: " + err.message;
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Bloquear";
    }
  });

  /* =========================================================
     FECHAMENTO DO DIA
     ========================================================= */
  $("#closeModalX").addEventListener("click", closeAllModals);

  $("#closeCopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#closeReport").textContent);
      toast("Relatório copiado.");
    } catch (e) {
      toast("Não consegui copiar o relatório.", true);
    }
  });

  $("#closeSend").addEventListener("click", e => {
    if (e.currentTarget.getAttribute("aria-disabled") === "true") e.preventDefault();
  });

  async function openCloseDay(day) {
    closeAllModals();

    const [from, to] = dayRange(day);
    let rows = [], blocks = [];
    try {
      [rows, blocks] = await Promise.all([fetchBookings(from, to), fetchBlocks(from, to)]);
    } catch (err) {
      toast("Não consegui carregar o dia: " + err.message, true);
      return;
    }

    const done = rows.filter(b => b.status === "done");
    const confirmed = rows.filter(b => b.status === "confirmed");
    const pending = rows.filter(b => b.status === "pending");
    const noShow = rows.filter(b => b.status === "no_show");
    const cancelled = rows.filter(b => b.status === "cancelled");
    const sum = list => list.reduce((s, b) => s + b.price_cents, 0);
    const total = sum([...done, ...confirmed, ...pending]);

    const byService = new Map();
    for (const b of [...done, ...confirmed, ...pending]) {
      const name = (b.service && b.service.name) || "Serviço";
      const cur = byService.get(name) || { n: 0, sum: 0 };
      cur.n += 1;
      cur.sum += b.price_cents;
      byService.set(name, cur);
    }

    const lines = [
      `*${tenant.name}*`,
      `Fechamento de ${fmtDateLong(day).toLowerCase()}`,
      "",
      `Agendamentos: ${done.length + confirmed.length + pending.length + noShow.length}`,
      `Concluídos: ${done.length}${done.length ? " · " + money(sum(done)) : ""}`,
      `Confirmados: ${confirmed.length}${confirmed.length ? " · " + money(sum(confirmed)) : ""}`,
      `Pendentes: ${pending.length}${pending.length ? " · " + money(sum(pending)) : ""}`,
      `Faltas: ${noShow.length}`,
      `Cancelados: ${cancelled.length}`
    ];
    if (blocks.length) lines.push(`Bloqueios: ${blocks.length}`);
    lines.push("", `*Previsto:* ${money(total)}`, `*Concluído:* ${money(sum(done))}`);
    if (byService.size) {
      lines.push("", "*Serviços*");
      for (const [name, v] of byService) {
        lines.push(`• ${name} — ${v.n}x — ${money(v.sum)}`);
      }
    }
    if (!byService.size) lines.push("", "Sem agendamentos neste dia.");

    const text = lines.join("\n");
    $("#closeReport").textContent = text;
    $("#closeSub").textContent = fmtDateLong(day);

    const phone = onlyDigits(tenant.whatsapp);
    const send = $("#closeSend");
    if (phone) {
      send.href = `https://wa.me/${waPhone(phone)}?text=${encodeURIComponent(text)}`;
      send.removeAttribute("aria-disabled");
    } else {
      send.href = "#";
      send.setAttribute("aria-disabled", "true");
      $("#closeSub").textContent = fmtDateLong(day) + " · cadastre o WhatsApp em Ajustes";
    }

    closeDayModal.hidden = false;
  }

  /* ---------------- resumo ---------------- */
  function periodRange(period) {
    const today = todayInTz();
    if (period === "today") return [today, addDays(today, 1)];

    if (period === "week") {
      const monday = addDays(today, -((weekdayOf(today) + 6) % 7));
      return [monday, addDays(monday, 7)];
    }

    const y = Number(today.slice(0, 4));
    const m = Number(today.slice(5, 7));
    const first = `${y}-${String(m).padStart(2, "0")}-01`;
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    return [first, next];
  }

  function availableMinutes(fromDate, toDate) {
    let total = 0;
    const today = todayInTz();
    for (let d = fromDate; d < toDate; d = addDays(d, 1)) {
      if (d > today) break;
      const h = hours[weekdayOf(d)];
      if (h && !h.closed) {
        const [oh, om] = h.opens_at.split(":").map(Number);
        const [ch, cm] = h.closes_at.split(":").map(Number);
        total += (ch * 60 + cm) - (oh * 60 + om);
      }
    }
    return total;
  }

  const shortDate = dateStr => `${dateStr.slice(8, 10)}/${dateStr.slice(5, 7)}`;

  async function renderSummary() {
    if (!tenant) return;

    const period = $("#periodSelect").value;
    const [fromDate, toDate] = periodRange(period);
    const [from, to] = [zonedToUtc(fromDate, "00:00", tenant.timezone), zonedToUtc(toDate, "00:00", tenant.timezone)];

    const monthFmt = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" })
      .format(new Date(fromDate + "T12:00:00Z"));
    const labels = {
      today: "Hoje · " + fmtDateLong(fromDate),
      week: `${shortDate(fromDate)} a ${shortDate(addDays(toDate, -1))}`,
      month: monthFmt.charAt(0).toUpperCase() + monthFmt.slice(1)
    };
    $("#periodLabel").textContent = labels[period];

    $("#kpis").innerHTML = '<div class="skeleton" style="height:92px"></div>'.repeat(4);
    $("#topServices").innerHTML = "";
    $("#upcoming").innerHTML = "";

    let rows = [];
    try {
      rows = await fetchBookings(from.toISOString(), to.toISOString());
    } catch (err) {
      $("#kpis").innerHTML = `<div class="empty"><b>Não consegui carregar o resumo</b>${esc(err.message)}</div>`;
      return;
    }

    const active = rows.filter(b => ["pending", "confirmed", "done"].includes(b.status));
    const done = rows.filter(b => b.status === "done");
    const noShow = rows.filter(b => b.status === "no_show");

    const forecast = active.reduce((s, b) => s + b.price_cents, 0);
    const realized = done.reduce((s, b) => s + b.price_cents, 0);
    const ticket = active.length ? Math.round(forecast / active.length) : 0;

    const now = Date.now();
    const bookedMinutes = active
      .filter(b => new Date(b.starts_at).getTime() <= now)
      .reduce((s, b) => s + (new Date(b.ends_at) - new Date(b.starts_at)) / 60000, 0);
    const available = availableMinutes(fromDate, toDate);
    const occupancy = available ? Math.min(100, Math.round(bookedMinutes / available * 100)) : 0;

    $("#kpis").innerHTML = [
      kpi("Agendamentos", String(active.length), period === "today" ? "hoje" : "no período"),
      kpi("Faturamento previsto", money(forecast), `${money(realized)} já realizado`),
      kpi("Ticket médio", money(ticket), "por agendamento"),
      kpi("Ocupação", occupancy + "%", `até agora · ${noShow.length} falta${noShow.length === 1 ? "" : "s"}`)
    ].join("");

    // serviços mais vendidos
    const byService = new Map();
    for (const b of active) {
      const name = (b.service && b.service.name) || "Outros";
      const cur = byService.get(name) || { count: 0, total: 0 };
      cur.count++;
      cur.total += b.price_cents;
      byService.set(name, cur);
    }
    const top = [...byService.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5);
    const max = top.length ? top[0][1].count : 1;

    $("#topServices").innerHTML = top.length
      ? top.map(([name, v]) => `
        <div class="rank-item">
          <b>${esc(name)}</b>
          <span>${v.count}x · ${money(v.total)}</span>
          <div class="bar"><i style="width:${Math.round(v.count / max * 100)}%"></i></div>
        </div>`).join("")
      : `<div class="empty">Nenhum agendamento no período.</div>`;

    // próximos agendamentos (a partir de agora)
    try {
      const next = await api(`bookings?tenant_id=eq.${tenant.id}`
        + `&starts_at=gte.${encodeURIComponent(new Date().toISOString())}`
        + `&status=in.(pending,confirmed)`
        + `&select=${BOOKING_FIELDS}&order=starts_at.asc&limit=5`);

      $("#upcoming").innerHTML = next.length
        ? next.map(b => `
          <div class="mini-item">
            <span class="m-time">${fmtDateShort(b.starts_at)}</span>
            <span class="m-main">
              <b>${esc((b.customer && b.customer.name) || "Cliente")}</b>
              <small>${hhmm(b.starts_at)} · ${esc((b.service && b.service.name) || "Serviço")}</small>
            </span>
            <span class="m-price">${money(b.price_cents)}</span>
          </div>`).join("")
        : `<div class="empty">Nada agendado daqui para frente.</div>`;
    } catch (e) {
      $("#upcoming").innerHTML = `<div class="empty">Não consegui carregar.</div>`;
    }
  }

  const kpi = (label, value, hint) => `
    <div class="kpi"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(hint)}</small></div>`;

  $("#periodSelect").addEventListener("change", renderSummary);

  /* ---------------- toast ---------------- */
  let toastTimer = null;
  function toast(message, isError) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.toggle("err", !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  /* ---------------- boot ---------------- */
  $("#logoutBtn").addEventListener("click", logout);

  // atualiza a agenda sozinho a cada minuto, só com a aba visível
  setInterval(() => {
    if (!tenant || document.hidden) return;
    if (currentTab === "agenda") renderAgenda();
  }, 60000);

  async function boot() {
    session = readSession();
    if (!session) { showLogin(""); return; }

    try {
      user = await getMe();
      await start();
    } catch (err) {
      clearSession();
      showLogin("Sua sessão expirou. Entre de novo.");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
