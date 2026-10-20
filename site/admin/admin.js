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

  const STATUS = {
    pending: { label: "Pendente", cls: "pending" },
    confirmed: { label: "Confirmado", cls: "confirmed" },
    done: { label: "Concluído", cls: "done" },
    no_show: { label: "Faltou", cls: "noshow" },
    cancelled: { label: "Cancelado", cls: "cancelled" }
  };

  const BOOKING_FIELDS = "id,code,starts_at,ends_at,price_cents,status,notes,vehicle_id,"
    + "customer:customers(id,name,phone),service:services(id,name),vehicle:vehicles(name)";

  /* ---------------- estado ---------------- */
  let session = null;
  let user = null;
  let memberships = [];
  let tenant = null;
  let hours = {};
  let currentDay = null;
  let currentTab = "agenda";
  let clientsCache = null;

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

    memberships = await api("memberships?select=tenant_id,role,tenants(id,slug,name,timezone)");
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

    $("#tenantName").textContent = tenant.name;
    $("#brandMark").textContent = initial(tenant.name);
    $("#loginMark").textContent = initial(tenant.name);
    $("#userEmail").textContent = (user && user.email) || session.email || "";
    document.title = tenant.name + " · Painel";

    hours = {};
    try {
      const rows = await api(`business_hours?tenant_id=eq.${tenant.id}&select=weekday,opens_at,closes_at,closed&order=weekday`);
      for (const r of rows) hours[r.weekday] = r;
    } catch (e) { /* agenda ainda funciona sem os horários */ }

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

    if (tab === "agenda") renderAgenda();
    if (tab === "clientes") renderClients();
    if (tab === "resumo") renderSummary();
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

  async function renderAgenda() {
    if (!tenant) return;

    $("#dayTitle").textContent = fmtDateLong(currentDay);
    $("#daySummary").textContent = "Carregando…";
    agendaList.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';

    let rows = [];
    try {
      const [from, to] = dayRange(currentDay);
      rows = await fetchBookings(from, to);
    } catch (err) {
      agendaList.innerHTML = `<div class="empty"><b>Não consegui carregar a agenda</b>${esc(err.message)}</div>`;
      $("#daySummary").textContent = "";
      return;
    }

    const showCancelled = $("#showCancelled").checked;
    const visible = rows.filter(b => showCancelled || b.status !== "cancelled");
    const active = rows.filter(b => b.status !== "cancelled");
    const revenue = active
      .filter(b => ["pending", "confirmed", "done"].includes(b.status))
      .reduce((sum, b) => sum + b.price_cents, 0);
    const done = active.filter(b => b.status === "done").length;

    const parts = [
      `${active.length} ${active.length === 1 ? "agendamento" : "agendamentos"}`,
      `${money(revenue)} previstos`
    ];
    if (done) parts.push(`${done} concluído${done > 1 ? "s" : ""}`);
    $("#daySummary").textContent = parts.join(" · ");

    if (!visible.length) {
      agendaList.innerHTML = `<div class="empty"><b>Nenhum agendamento neste dia</b>
        ${rows.length && !showCancelled ? "Só há cancelados — marque “Cancelados” para ver." : "Quando alguém agendar pela página, aparece aqui."}
      </div>`;
      return;
    }

    agendaList.innerHTML = visible.map(bookingRow).join("");
  }

  function bookingRow(b) {
    const st = STATUS[b.status] || STATUS.confirmed;
    const c = b.customer || {};
    const phone = c.phone ? `<a href="https://wa.me/${waPhone(c.phone)}" target="_blank" rel="noopener">${esc(fmtPhone(c.phone))}</a>` : "";
    const service = [b.service && b.service.name, b.vehicle && b.vehicle.name].filter(Boolean).join(" · ");

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

    if (b.status === "pending") {
      return btn("confirmed", "Confirmar", "ok") + btn("cancelled", "Cancelar", "danger");
    }
    if (b.status === "confirmed") {
      return btn("done", "Concluir", "ok")
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
      + `&select=id,name,phone,created_at,bookings(starts_at,status,price_cents,service:services(name))`
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

  function openClient(id) {
    const c = (clientsCache || []).find(x => x.id === id);
    if (!c) return;

    $("#clientModalName").textContent = c.name;
    const phone = c.phone
      ? `<a href="https://wa.me/${waPhone(c.phone)}" target="_blank" rel="noopener">${esc(fmtPhone(c.phone))}</a>`
      : "sem telefone";
    $("#clientModalMeta").innerHTML = `${phone} · ${c.visits} ${c.visits === 1 ? "visita" : "visitas"} · ${money(c.spent)}`;

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

  function closeModal() { modal.hidden = true; }

  $("#clientModalClose").addEventListener("click", closeModal);
  modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
  addEventListener("keydown", e => { if (e.key === "Escape" && !modal.hidden) closeModal(); });

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
