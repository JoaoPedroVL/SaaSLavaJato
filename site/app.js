/* =============================================================
   LavaJato SaaS — landing ligada no Supabase
   Dados de serviços, preços, horários e agendamentos vêm do banco.
   ============================================================= */
(function () {
  "use strict";

  const CFG = window.LAVA_CONFIG || {};
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const WEEK = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
  const WEEK_SHORT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

  /* ---------------- estado ---------------- */
  let tenant = null;
  let vehicles = [];
  let services = [];
  let hours = {};
  let currentVehicle = null;
  let busyCache = new Map();

  const state = {
    step: "veiculo", vehicle: null, service: null,
    dateStr: null, slot: null, name: "", phone: "", pendingService: null
  };

  /* ---------------- utilidades ---------------- */
  const money = cents => {
    const v = (cents || 0) / 100;
    const dec = cents % 100 === 0 ? 0 : 2;
    return "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: 2 });
  };

  const dur = m => {
    if (m < 60) return m + " min";
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h}h${String(r).padStart(2, "0")}` : `${h}h`;
  };

  const wait = ms => new Promise(r => setTimeout(r, ms));

  function fmtPhone(p) {
    const d = String(p || "").replace(/\D/g, "");
    const local = d.startsWith("55") ? d.slice(2) : d;
    if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
    if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
    return p || "";
  }

  function maskPhone(v) {
    const d = v.replace(/\D/g, "").slice(0, 11);
    if (d.length <= 2) return d;
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }

  /* ---------------- fuso horário ---------------- */
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
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return asUTC - date.getTime();
  }

  function zonedToUtc(dateStr, hhmm, tz) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const [h, mi] = hhmm.split(":").map(Number);
    const naive = Date.UTC(y, m - 1, d, h, mi, 0);
    let off = tzOffsetMs(new Date(naive), tz);
    off = tzOffsetMs(new Date(naive - off), tz);
    return new Date(naive - off);
  }

  function todayInTz(tz) {
    const p = partsInTz(new Date(), tz);
    return `${p.year}-${p.month}-${p.day}`;
  }

  function addDays(dateStr, n) {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function weekdayOf(dateStr) {
    return new Date(dateStr + "T00:00:00Z").getUTCDay();
  }

  function dayLabel(dateStr) {
    const today = todayInTz(tenant.timezone);
    if (dateStr === today) return "Hoje";
    if (dateStr === addDays(today, 1)) return "Amanhã";
    const [, m, d] = dateStr.split("-");
    return `${WEEK_SHORT[weekdayOf(dateStr)]} ${d}/${m}`;
  }

  function fmtDateTime(iso, withTime = true) {
    const opts = { timeZone: tenant.timezone, day: "2-digit", month: "2-digit" };
    if (withTime) { opts.hour = "2-digit"; opts.minute = "2-digit"; }
    return new Intl.DateTimeFormat("pt-BR", opts).format(new Date(iso)).replace(", ", " às ");
  }

  /* ---------------- API ---------------- */
  class ApiError extends Error {
    constructor(message) { super(message); this.name = "ApiError"; }
  }

  async function api(path, opts = {}) {
    const url = CFG.supabaseUrl.replace(/\/$/, "") + "/rest/v1/" + path;
    const res = await fetch(url, {
      ...opts,
      headers: {
        apikey: CFG.supabaseAnonKey,
        Authorization: "Bearer " + CFG.supabaseAnonKey,
        "Content-Type": "application/json",
        ...(opts.headers || {})
      }
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) throw new ApiError((data && data.message) || "api_error");
    return data;
  }

  const rpc = (fn, body) => api("rpc/" + fn, { method: "POST", body: JSON.stringify(body) });

  /* ---------------- carregamento ---------------- */
  async function loadData() {
    const slug = CFG.tenantSlug;
    const [t, v, s, h] = await Promise.all([
      api(`public_tenants?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`),
      api(`vehicles?select=id,name,hint,sort_order&order=sort_order`),
      api(`public_services?tenant_slug=eq.${encodeURIComponent(slug)}&select=*&order=sort_order`),
      api(`public_hours?tenant_slug=eq.${encodeURIComponent(slug)}&select=*&order=weekday`)
    ]);

    if (!t || !t.length) throw new Error("tenant_not_found");
    tenant = t[0];
    vehicles = v || [];

    const map = new Map();
    for (const row of s || []) {
      let svc = map.get(row.service_id);
      if (!svc) {
        svc = {
          id: row.service_id, name: row.name, description: row.description,
          minutes: row.minutes, sort_order: row.sort_order, prices: {}, durations: {}
        };
        map.set(row.service_id, svc);
      }
      svc.prices[row.vehicle_id] = row.price_cents;
      svc.durations[row.vehicle_id] = row.duration_minutes;
    }
    services = [...map.values()].sort((a, b) => a.sort_order - b.sort_order);

    hours = {};
    for (const row of h || []) {
      hours[row.weekday] = {
        closed: row.closed, opens_at: row.opens_at, closes_at: row.closes_at
      };
    }

    const saved = (() => { try { return localStorage.getItem("lavajato_vehicle"); } catch (e) { return null; } })();
    currentVehicle = vehicles.find(v => v.id === saved) || vehicles[0] || null;
  }

  function priceFor(svc, v = currentVehicle) {
    return svc.prices[v.id];
  }
  function durationFor(svc, v = currentVehicle) {
    return svc.durations[v.id];
  }
  function servicesForVehicle(v = currentVehicle) {
    return services.filter(s => s.prices[v.id] != null);
  }

  /* ---------------- página ---------------- */
  function applyTenant() {
    document.title = `${tenant.name} | Agende online`;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute("content", `Agende lavagem e estética automotiva em ${tenant.address || tenant.name}. Preço por tipo de carro e horário disponível na hora.`);

    const phone = tenant.whatsapp ? fmtPhone(tenant.whatsapp) : "";
    const topPhone = $("#topPhone");
    if (topPhone && tenant.whatsapp) {
      topPhone.textContent = phone;
      topPhone.href = "tel:+" + tenant.whatsapp.replace(/\D/g, "");
    }

    const initial = (tenant.name || "?").trim().charAt(0).toUpperCase();
    for (const id of ["logoMark", "chatAvatar"]) {
      const el = $("#" + id);
      if (el) el.textContent = initial;
    }

    const chatTitle = $("#chatTitle");
    if (chatTitle) chatTitle.textContent = tenant.name;

    const footerName = $("#footerName");
    if (footerName) footerName.textContent = tenant.name;

    const footerCity = $("#footerCity");
    if (footerCity && tenant.address) {
      const parts = tenant.address.split(",").map(s => s.trim()).filter(Boolean);
      footerCity.textContent = parts.length >= 2 ? parts.slice(-2).join(", ") : parts[0];
    }

    const addr = $("#addrText");
    if (addr && tenant.address) {
      const parts = tenant.address.split(",").map(s => s.trim()).filter(Boolean);
      addr.innerHTML = parts.length >= 3
        ? esc(parts.slice(0, -2).join(", ")) + "<br>" + esc(parts.slice(-2).join(", "))
        : esc(tenant.address);
    }

    const mapLink = $("#mapLink");
    if (mapLink && tenant.map_query) mapLink.href = "https://maps.google.com/?q=" + encodeURIComponent(tenant.map_query);

    const mapFrame = $("#mapFrame");
    if (mapFrame && tenant.map_query) {
      mapFrame.src = "https://www.google.com/maps?q=" + encodeURIComponent(tenant.map_query) + "&output=embed&z=14";
    }
  }

  function renderVehicleOptions() {
    const el = $("#vehicleOptions");
    if (!el) return;
    el.innerHTML = vehicles.map(v => `
      <button class="vp-opt ${v.id === currentVehicle.id ? "active" : ""}"
              data-vehicle="${v.id}" aria-pressed="${v.id === currentVehicle.id}">
        <b>${esc(v.name)}</b>
        <small>${esc(v.hint || "")}</small>
      </button>`).join("");
  }

  const ICONS = {
    lavagem: '<svg viewBox="0 0 24 24"><path d="M4 16h16M6 16l1.5-5.5A2 2 0 0 1 9.4 9h5.2a2 2 0 0 1 1.9 1.5L18 16"/><circle cx="7.5" cy="18" r="1.6"/><circle cx="16.5" cy="18" r="1.6"/></svg>',
    higienizacao: '<svg viewBox="0 0 24 24"><path d="M6 20V9a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v11"/><path d="M6 20h12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M10 12h4"/></svg>',
    polimento: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4v3M12 17v3M4 12h3M17 12h3"/></svg>',
    cristalizacao: '<svg viewBox="0 0 24 24"><path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2L12 3z"/></svg>',
    default: '<svg viewBox="0 0 24 24"><path d="M4 16h16M6 16l1.5-5.5A2 2 0 0 1 9.4 9h5.2a2 2 0 0 1 1.9 1.5L18 16"/><circle cx="7.5" cy="18" r="1.6"/><circle cx="16.5" cy="18" r="1.6"/></svg>'
  };

  function iconFor(name) {
    const n = name.toLowerCase();
    if (n.includes("higien")) return ICONS.higienizacao;
    if (n.includes("polim")) return ICONS.polimento;
    if (n.includes("cristal")) return ICONS.cristalizacao;
    if (n.includes("lav")) return ICONS.lavagem;
    return ICONS.default;
  }

  function renderServices(flash) {
    const el = $("#services");
    if (!el) return;
    const list = servicesForVehicle();
    el.innerHTML = list.map(s => `
      <article class="svc">
        <div class="svc-top">
          <span class="svc-icon" aria-hidden="true">${iconFor(s.name)}</span>
          <span class="time">${dur(durationFor(s))}</span>
        </div>
        <h3>${esc(s.name)}</h3>
        <p>${esc(s.description || "")}</p>
        <div class="svc-price"><small>${esc(currentVehicle.name)} · a partir de</small>${money(priceFor(s))}</div>
        <button class="svc-btn" data-book data-service="${s.id}">Agendar</button>
      </article>
    `).join("");

    if (flash) {
      el.classList.add("flash-prices");
      setTimeout(() => el.classList.remove("flash-prices"), 420);
    }
  }

  function renderHeroQuick() {
    const el = $("#quickList");
    if (!el) return;
    el.innerHTML = servicesForVehicle().slice(0, 4).map(s => `
      <button class="quick-item" data-book data-service="${s.id}">
        <span>
          <b>${esc(s.name)}</b>
          <small>${dur(durationFor(s))} · ${esc(currentVehicle.name)}</small>
        </span>
        <span class="price">${money(priceFor(s))}</span>
      </button>
    `).join("");
  }

  function renderBar() {
    const list = servicesForVehicle();
    if (!list.length) return;
    const cheapest = Math.min(...list.map(s => priceFor(s)));
    const simples = list.find(s => /simples/i.test(s.name)) || list[0];
    const bp = $("#barPrice"), bt = $("#barTime");
    if (bp) bp.textContent = "A partir de " + money(cheapest);
    if (bt) bt.textContent = "Lavagem em " + dur(durationFor(simples));
  }

  function hoursSummary() {
    const open = [0, 1, 2, 3, 4, 5, 6].filter(d => hours[d] && !hours[d].closed);
    if (!open.length) return "Fechado";
    if (open.length === 7) return "Todos os dias";
    const contiguous = open.every((d, i) => i === 0 || d === open[i - 1] + 1);
    if (contiguous && open.length > 2) {
      return `${WEEK_SHORT[open[0]]} a ${WEEK_SHORT[open[open.length - 1]].toLowerCase()}`;
    }
    return open.map(d => WEEK_SHORT[d]).join(", ");
  }

  function renderHours() {
    const heroHours = $("#heroHours");
    if (heroHours) heroHours.textContent = "🕘 " + hoursSummary();

    const el = $("#hoursTable");
    if (!el) return;
    const today = weekdayOf(todayInTz(tenant.timezone));
    el.innerHTML = [1, 2, 3, 4, 5, 6, 0].map(d => {
      const h = hours[d];
      const label = !h || h.closed
        ? "Fechado"
        : `${h.opens_at.slice(0, 5)} – ${h.closes_at.slice(0, 5)}`;
      return `<tr class="${d === today ? "today" : ""}"><td>${WEEK[d]}</td><td>${label}</td></tr>`;
    }).join("");
  }

  function updateStatus() {
    const el = $("#openStatus");
    if (!el) return;
    const p = partsInTz(new Date(), tenant.timezone);
    const today = weekdayOf(`${p.year}-${p.month}-${p.day}`);
    const h = hours[today];
    const mins = +p.hour * 60 + +p.minute;
    let open = false, text = "";

    if (h && !h.closed) {
      const [oh, om] = h.opens_at.split(":").map(Number);
      const [ch, cm] = h.closes_at.split(":").map(Number);
      open = mins >= oh * 60 + om && mins < ch * 60 + cm;
      if (open) text = `Aberto agora · fecha às ${h.closes_at.slice(0, 5)}`;
      else if (mins < oh * 60 + om) text = `Abre hoje às ${h.opens_at.slice(0, 5)}`;
      else text = `Fechado · abre ${nextOpenDay(today, p)}`;
    } else {
      text = `Fechado hoje · abre ${nextOpenDay(today, p)}`;
    }

    el.classList.toggle("closed", !open);
    el.innerHTML = `<span class="dot" aria-hidden="true"></span><span>${text}</span>`;
    el.setAttribute("aria-label", text);
  }

  function nextOpenDay(today, p) {
    for (let i = 1; i <= 7; i++) {
      const d = (today + i) % 7;
      const h = hours[d];
      if (h && !h.closed) {
        const label = i === 1 ? "amanhã" : WEEK[d].toLowerCase();
        return `${label} às ${h.opens_at.slice(0, 5)}`;
      }
    }
    return "em breve";
  }

  function setVehicle(v, opts = {}) {
    if (!v) return;
    currentVehicle = v;
    try { localStorage.setItem("lavajato_vehicle", v.id); } catch (e) {}
    renderVehicleOptions();
    renderServices(!!opts.flash);
    renderHeroQuick();
    renderBar();
  }

  /* ---------------- disponibilidade ---------------- */
  async function busyFor(dateStr) {
    const key = dateStr;
    if (busyCache.has(key)) return busyCache.get(key);
    const rows = await rpc("busy_slots", { p_slug: tenant.slug, p_day: dateStr });
    const list = (rows || []).map(r => ({ start: new Date(r.starts_at), end: new Date(r.ends_at) }));
    busyCache.set(key, list);
    return list;
  }

  function buildSlots(dateStr, minutes, busy) {
    const wd = weekdayOf(dateStr);
    const h = hours[wd];
    if (!h || h.closed) return [];

    const [oh, om] = h.opens_at.split(":").map(Number);
    const [ch, cm] = h.closes_at.split(":").map(Number);
    const openM = oh * 60 + om, closeM = ch * 60 + cm;
    const now = Date.now();
    const out = [];

    for (let m = openM; m + minutes <= closeM; m += 30) {
      const hhmm = String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
      const start = zonedToUtc(dateStr, hhmm, tenant.timezone);
      const end = new Date(start.getTime() + minutes * 60000);
      if (start.getTime() <= now) continue;
      if (busy.some(b => start < b.end && end > b.start)) continue;
      out.push({ hhmm, iso: start.toISOString() });
    }
    return out;
  }

  /* ---------------- conteúdo fixo (avaliações/FAQ) ---------------- */
  const CONTENT = {
    reviews: [
      { name: "Marcos Almeida", car: "Corolla", text: "Levei pra higienização e o carro saiu com cheiro de novo. Atendimento no horário, sem enrolação." },
      { name: "Juliana Prado", car: "Jeep Compass", text: "Agendei pelo site em dois minutos. O polimento ficou melhor do que eu esperava." },
      { name: "Rafael Souza", car: "Golf GTI", text: "Preço justo e serviço caprichado de verdade. Já virei cliente fixo." }
    ],
    faq: [
      ["Precisa agendar?", "Não é obrigatório, mas quem agenda tem prioridade e não espera. Sem horário, o atendimento é por ordem de chegada."],
      ["Como o preço é calculado?", "Cada serviço tem um valor por porte de veículo: hatch, sedan, SUV e picape. É só selecionar o seu carro na tabela de serviços que o preço e o tempo se ajustam."],
      ["Quanto tempo demora?", "Depende do serviço e do porte do carro. A duração de cada serviço aparece na tabela acima, já ajustada para o seu veículo."],
      ["Vocês buscam o carro?", "Sim, para serviços a partir de R$ 149 em Linhares. Combine pelo WhatsApp na hora de agendar."],
      ["Quais as formas de pagamento?", "Pix, dinheiro, cartão de crédito e débito. Parcelamos polimento e cristalização em até 3x sem juros."],
      ["O que é cristalização?", "É uma camada de proteção aplicada sobre a pintura que mantém o brilho por mais tempo e facilita a limpeza do dia a dia."],
      ["Atendem domingo?", "O horário de funcionamento está na seção de contato, atualizado pelo próprio lava-jato."]
    ]
  };

  function renderStatic() {
    const reviews = $("#reviews");
    if (reviews) {
      reviews.innerHTML = CONTENT.reviews.map(r => {
        const initials = r.name.split(" ").map(n => n[0]).slice(0, 2).join("");
        return `
        <article class="review">
          <span class="stars" aria-label="5 de 5 estrelas">★★★★★</span>
          <p>“${esc(r.text)}”</p>
          <div class="review-author">
            <span class="avatar" aria-hidden="true">${esc(initials)}</span>
            <span><b>${esc(r.name)}</b><small>${esc(r.car)}</small></span>
            <span class="g-badge">Google</span>
          </div>
        </article>`;
      }).join("");
    }

    const faq = $("#faq");
    if (faq) {
      faq.innerHTML = CONTENT.faq.map(([q, a]) => `
        <details>
          <summary>${esc(q)}</summary>
          <div class="answer">${esc(a)}</div>
        </details>`).join("");
    }
  }

  /* ---------------- chat ---------------- */
  const chat = $("#chat"), chatBody = $("#chatBody"), chatQuick = $("#chatQuick");
  const chatInput = $("#chatInput"), chatSend = $("#chatSend"), chatForm = $("#chatForm");
  const fab = $("#chatFab"), mobileBar = $("#mobileBar");

  function waLink(text) {
    const base = "https://wa.me/" + String(tenant.whatsapp || CFG.fallbackWhatsapp).replace(/\D/g, "");
    return base + (text ? "?text=" + encodeURIComponent(text) : "");
  }

  function setInput(enabled, placeholder, mode) {
    chatInput.disabled = !enabled;
    chatSend.disabled = !enabled;
    chatInput.placeholder = placeholder || "Digite sua resposta…";
    chatInput.inputMode = mode || "text";
  }

  function scrollBottom() { chatBody.scrollTop = chatBody.scrollHeight; }

  function addMsg(html, who = "bot") {
    const d = document.createElement("div");
    d.className = "msg " + who;
    d.innerHTML = html;
    chatBody.appendChild(d);
    scrollBottom();
    return d;
  }

  function typing() {
    const t = document.createElement("div");
    t.className = "typing";
    t.innerHTML = "<i></i><i></i><i></i>";
    chatBody.appendChild(t);
    scrollBottom();
    return t;
  }

  async function botSay(html, quick, delay = 380) {
    const t = typing();
    await wait(delay);
    t.remove();
    addMsg(html, "bot");
    renderQuick(quick || []);
  }

  function renderQuick(items) {
    chatQuick.innerHTML = "";
    (items || []).forEach(item => {
      const b = document.createElement("button");
      b.className = "quick";
      b.type = "button";
      b.textContent = item.label;
      b.addEventListener("click", () => {
        chatQuick.innerHTML = "";
        Promise.resolve(item.run()).catch(() => {});
      });
      chatQuick.appendChild(b);
    });
    scrollBottom();
  }

  function openChat(serviceId) {
    chat.hidden = false;
    fab.setAttribute("aria-expanded", "true");
    mobileBar.style.display = "none";
    if (matchMedia("(max-width:760px)").matches) document.body.style.overflow = "hidden";
    if (serviceId) {
      const svc = services.find(s => s.id === serviceId);
      resetFlow(svc || null);
    } else if (!chatBody.childElementCount) {
      resetFlow(null);
    }
    setTimeout(() => chatInput.focus({ preventScroll: true }), 80);
  }

  function closeChat() {
    chat.hidden = true;
    fab.setAttribute("aria-expanded", "false");
    mobileBar.style.display = "";
    document.body.style.overflow = "";
    fab.focus({ preventScroll: true });
  }

  function resetFlow(pendingService) {
    state.step = "veiculo";
    state.vehicle = null; state.service = null; state.dateStr = null;
    state.slot = null; state.name = ""; state.phone = "";
    state.pendingService = pendingService || null;
    chatBody.innerHTML = "";
    chatQuick.innerHTML = "";
    chatInput.value = "";
    setInput(false);

    if (!vehicles.length) {
      botSay("Estamos com dificuldade para carregar os horários agora. Chame no WhatsApp que a gente resolve.", [
        { label: "Chamar no WhatsApp", run: () => window.open(waLink(), "_blank", "noopener") }
      ]);
      return;
    }

    const intro = pendingService
      ? `Oi! 👋 Você escolheu <b>${esc(pendingService.name)}</b>. Antes, qual é o seu carro?`
      : `Oi! 👋 Aqui é a <b>${esc(tenant.name)}</b>. Vou te ajudar a agendar em 30 segundos.<br><b>Qual é o seu carro?</b>`;

    botSay(intro, vehicleChips());
  }

  function vehicleChips() {
    return vehicles.map(v => ({ label: v.name, run: () => selectVehicle(v) }));
  }

  function serviceChips() {
    return servicesForVehicle().map(s => ({
      label: `${s.name} · ${money(priceFor(s))}`,
      run: () => selectService(s)
    })).concat([{ label: "Só tenho uma dúvida", run: askDoubt }]);
  }

  async function selectVehicle(v) {
    state.vehicle = v;
    setVehicle(v);
    addMsg(esc(v.name), "user");

    if (state.pendingService) {
      const svc = state.pendingService;
      state.pendingService = null;
      await startService(svc);
    } else {
      state.step = "servico";
      setInput(false);
      await botSay(`Beleza! Para um <b>${esc(v.name)}</b>, qual serviço?`, serviceChips());
    }
  }

  async function selectService(svc) {
    addMsg(esc(svc.name), "user");
    await startService(svc);
  }

  async function startService(svc) {
    state.service = svc;
    state.step = "dia";
    setInput(false);
    const days = await loadDays(svc);
    if (!days.length) {
      await botSay("Não encontrei horário livre nos próximos dias 😕 Quer falar com a gente no WhatsApp?", [
        { label: "Chamar no WhatsApp", run: () => window.open(waLink(`Olá! Quero agendar ${svc.name}.`), "_blank", "noopener") }
      ]);
      return;
    }
    await botSay(
      `<b>${esc(svc.name)}</b> — ${money(priceFor(svc))} · ${dur(durationFor(svc))}.<br>Para qual dia você quer?`,
      days.map(d => ({ label: dayLabel(d), run: () => selectDay(d) }))
    );
  }

  async function loadDays(svc) {
    const tz = tenant.timezone;
    const today = todayInTz(tz);
    const minutes = durationFor(svc);
    const candidates = [];

    for (let i = 0; i < 10; i++) {
      const ds = addDays(today, i);
      const h = hours[weekdayOf(ds)];
      if (h && !h.closed) candidates.push(ds);
    }

    const results = await Promise.all(candidates.map(async ds => {
      try {
        const busy = await busyFor(ds);
        return { ds, slots: buildSlots(ds, minutes, busy) };
      } catch (e) {
        return { ds, slots: [] };
      }
    }));

    return results.filter(r => r.slots.length).slice(0, 5).map(r => r.ds);
  }

  async function selectDay(dateStr) {
    state.dateStr = dateStr;
    addMsg(dayLabel(dateStr), "user");
    busyCache.delete(dateStr);

    let slots = [];
    try {
      const busy = await busyFor(dateStr);
      slots = buildSlots(dateStr, durationFor(state.service), busy);
    } catch (e) {
      await botSay("Não consegui consultar a agenda agora. Tente de novo ou chame no WhatsApp.", [
        { label: "Chamar no WhatsApp", run: () => window.open(waLink(), "_blank", "noopener") }
      ]);
      return;
    }

    if (!slots.length) {
      const days = await loadDays(state.service);
      if (!days.length) {
        await botSay("Esse dia lotou e não achei outro horário livre 😕 Chame no WhatsApp que a gente encaixa você.", [
          { label: "Chamar no WhatsApp", run: () => window.open(waLink(`Olá! Quero agendar ${state.service.name}.`), "_blank", "noopener") }
        ]);
        return;
      }
      await botSay("Esse dia lotou 😕 Quer tentar outro?", days.map(d => ({ label: dayLabel(d), run: () => selectDay(d) })));
      return;
    }

    state.step = "hora";
    setInput(false);
    await botSay(`Tenho estes horários em <b>${dayLabel(dateStr)}</b>:`,
      slots.slice(0, 8).map(s => ({ label: s.hhmm, run: () => selectTime(s) })));
  }

  async function selectTime(slot) {
    state.slot = slot;
    addMsg(slot.hhmm, "user");

    // quem já trocou veículo/horário não precisa digitar nome e telefone de novo
    if (state.name) {
      if (state.phone) { await askConfirm(); return; }
      await askPhone();
      return;
    }

    state.step = "nome";
    setInput(true, "Seu nome");
    await botSay("Combinado! Como você se chama?", null);
    setTimeout(() => chatInput.focus({ preventScroll: true }), 400);
  }

  async function askPhone() {
    state.step = "telefone";
    setInput(true, "(27) 99999-9999", "tel");
    await botSay("Qual o seu WhatsApp? (para confirmar e lembrar do horário)", null);
    setTimeout(() => chatInput.focus({ preventScroll: true }), 400);
  }

  function confirmSummary() {
    const s = state.service, v = state.vehicle;
    return `<div class="sum">
        <span><i>Veículo</i> ${esc(v.name)}</span>
        <span><i>Serviço</i> ${esc(s.name)}</span>
        <span><i>Data</i> ${fmtDateTime(state.slot.iso)}</span>
        <span><i>Duração</i> ${dur(durationFor(s))}</span>
        <span><i>Valor</i> <b>${money(priceFor(s))}</b></span>
        <span><i>Nome</i> ${esc(state.name)}</span>
        <span><i>WhatsApp</i> ${esc(maskPhone(state.phone))}</span>
      </div>`;
  }

  async function askConfirm() {
    state.step = "confirmar";
    setInput(false);
    await botSay("Confere se está tudo certo?" + confirmSummary(), [
      { label: "Confirmar agendamento", run: finish },
      { label: "Trocar horário", run: changeTime },
      { label: "Trocar veículo", run: changeVehicle },
      { label: "Trocar serviço", run: changeService },
      { label: "Corrigir meus dados", run: fixData }
    ]);
  }

  async function changeService() {
    state.service = null;
    state.dateStr = null;
    state.slot = null;
    state.pendingService = null;
    state.step = "servico";
    setInput(false);
    await botSay("Sem problema. Qual serviço você prefere?", serviceChips());
  }

  async function fixData() {
    state.name = "";
    state.phone = "";
    state.step = "nome";
    setInput(true, "Seu nome");
    await botSay("Sem problema. Como você se chama?", null);
    setTimeout(() => chatInput.focus({ preventScroll: true }), 400);
  }

  async function changeTime() {
    state.slot = null;
    state.step = "dia";
    const days = await loadDays(state.service);
    if (!days.length) {
      await botSay("Não achei outro horário livre 😕 Chame no WhatsApp que a gente encaixa você.", [
        { label: "Chamar no WhatsApp", run: () => window.open(waLink(`Olá! Quero agendar ${state.service.name}.`), "_blank", "noopener") }
      ]);
      return;
    }
    await botSay("Sem problema. Para qual dia?", days.map(d => ({ label: dayLabel(d), run: () => selectDay(d) })));
  }

  async function changeVehicle() {
    state.pendingService = state.service;
    state.service = null; state.dateStr = null; state.slot = null;
    state.step = "veiculo";
    setInput(false);
    await botSay("Sem problema. Qual é o seu carro?", vehicleChips());
  }

  async function finish() {
    state.step = "enviando";
    setInput(false);
    const typingEl = typing();
    try {
      const res = await rpc("create_booking", {
        p_slug: tenant.slug,
        p_service_id: state.service.id,
        p_vehicle_id: state.vehicle.id,
        p_starts_at: state.slot.iso,
        p_name: state.name,
        p_phone: state.phone
      });
      typingEl.remove();
      showSuccess(res);
    } catch (e) {
      typingEl.remove();
      const msg = e && e.message;

      if (msg === "slot_taken") {
        state.step = "dia";
        state.slot = null;
        busyCache.delete(state.dateStr);
        const busy = await busyFor(state.dateStr).catch(() => []);
        const slots = buildSlots(state.dateStr, durationFor(state.service), busy);
        if (slots.length) {
          await botSay("Esse horário acabou de ser reservado 😕 Escolha outro:", slots.slice(0, 8).map(s => ({ label: s.hhmm, run: () => selectTime(s) })));
        } else {
          const days = await loadDays(state.service);
          await botSay("Esse horário acabou de ser reservado e o dia lotou. Quer tentar outro dia?",
            days.map(d => ({ label: dayLabel(d), run: () => selectDay(d) })));
        }
        return;
      }

      const textos = {
        outside_hours: "Esse horário está fora do funcionamento da loja.",
        past_slot: "Esse horário já passou.",
        service_not_found: "Esse serviço não está mais disponível.",
        price_not_found: "Esse serviço não tem preço para o seu veículo."
      };

      await botSay((textos[msg] || "Não consegui concluir o agendamento agora.") +
        "<br>Chame no WhatsApp que a gente resolve na hora.", [
        { label: "Chamar no WhatsApp", run: () => window.open(waLink(`Olá! Quero agendar ${state.service.name} para ${state.vehicle.name}.`), "_blank", "noopener") }
      ]);
    }
  }

  function icsFor(res) {
    const dt = iso => new Date(iso).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const clean = s => String(s || "").replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
    return [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//LavaJato//PT-BR", "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      `UID:${res.code}@${tenant.slug}`,
      `DTSTAMP:${dt(new Date().toISOString())}`,
      `DTSTART:${dt(res.starts_at)}`,
      `DTEND:${dt(res.ends_at)}`,
      `SUMMARY:${clean(res.service)} - ${clean(tenant.name)}`,
      `DESCRIPTION:${clean("Código do agendamento: " + res.code)}`,
      `LOCATION:${clean(tenant.address || "")}`,
      "END:VEVENT", "END:VCALENDAR"
    ].join("\r\n");
  }

  function downloadIcs(res) {
    const blob = new Blob([icsFor(res)], { type: "text/calendar;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `agendamento-${res.code}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function showSuccess(res) {
    chatQuick.innerHTML = "";
    const card = `
      <div class="success-card">
        <span class="success-label">Agendamento confirmado</span>
        <b class="success-code">${esc(res.code)}</b>
        <div class="sum">
          <span><i>Serviço</i> ${esc(res.service)}</span>
          <span><i>Veículo</i> ${esc(res.vehicle)}</span>
          <span><i>Data</i> ${fmtDateTime(res.starts_at)}</span>
          <span><i>Valor</i> <b>${money(res.price_cents)}</b></span>
        </div>
        <button type="button" class="btn btn-sm" style="margin-top:12px;width:100%" id="addCal">Adicionar ao calendário</button>
        <a class="chat-wa" href="${waLink("Olá! Tenho uma dúvida sobre o agendamento " + res.code + ".")}" target="_blank" rel="noopener">Falar sobre este agendamento</a>
      </div>`;

    botSay(`Prontinho, <b>${esc(state.name)}</b>! ✅<br>Seu horário está reservado. Guarde o código abaixo.`, null).then(() => {
      addMsg(card, "bot");
      const btn = $("#addCal");
      if (btn) btn.addEventListener("click", () => downloadIcs(res));
    });

    state.step = "fim";
    setInput(false, "Agendamento confirmado");
  }

  async function askDoubt() {
    addMsg("Só tenho uma dúvida", "user");
    state.step = "duvida";
    setInput(true, "Escreva sua dúvida");
    await botSay("Claro! Pode escrever aqui embaixo que eu respondo — ou, se preferir, falo com você no WhatsApp.", [
      { label: "Chamar no WhatsApp", run: () => window.open(waLink(), "_blank", "noopener") }
    ]);
  }

  chatForm.addEventListener("submit", async e => {
    e.preventDefault();
    const val = chatInput.value.trim();
    if (!val) return;

    if (state.step === "nome") {
      if (val.length < 2) {
        addMsg(esc(val), "user");
        chatInput.value = "";
        await botSay("Preciso do seu nome completo 🙂", null);
        return;
      }
      state.name = val;
      chatInput.value = "";
      addMsg(esc(val), "user");
      await askPhone();
      return;
    }

    if (state.step === "telefone") {
      const digits = val.replace(/\D/g, "");
      if (digits.length < 10) {
        addMsg(esc(val), "user");
        chatInput.value = "";
        await botSay("Esse número parece incompleto. Digite com DDD, ex.: (27) 99999-9999.", null);
        return;
      }
      state.phone = digits;
      chatInput.value = "";
      addMsg(esc(maskPhone(digits)), "user");
      await askConfirm();
      return;
    }

    if (state.step === "duvida") {
      addMsg(esc(val), "user");
      chatInput.value = "";
      setInput(false);
      await botSay("Anotado! Já chamo alguém da equipe. Se quiser adiantar, é só tocar abaixo.", [
        { label: "Chamar no WhatsApp", run: () => window.open(waLink("Olá! " + val), "_blank", "noopener") },
        { label: "Voltar ao agendamento", run: () => resetFlow(null) }
      ]);
      return;
    }

    addMsg(esc(val), "user");
    chatInput.value = "";
    await botSay("Para agendar é só escolher uma das opções acima 😉", null);
  });

  chatInput.addEventListener("input", () => {
    if (state.step === "telefone") {
      const pos = chatInput.selectionStart;
      chatInput.value = maskPhone(chatInput.value);
      chatInput.setSelectionRange(pos, pos);
    }
  });

  /* ---------------- inicialização ---------------- */
  async function boot() {
    renderStatic();

    try {
      await loadData();
    } catch (e) {
      const el = $("#services");
      if (el) {
        el.innerHTML = `<div class="load-error">Não consegui carregar os serviços agora. ${
          CFG.fallbackWhatsapp ? `<a href="https://wa.me/${CFG.fallbackWhatsapp}" target="_blank" rel="noopener">Chame no WhatsApp</a>.` : ""
        }</div>`;
      }
      const vp = document.querySelector(".vehicle-picker");
      if (vp) vp.style.display = "none";
      return;
    }

    applyTenant();
    renderVehicleOptions();
    renderServices();
    renderHeroQuick();
    renderBar();
    renderHours();
    updateStatus();
    setInterval(updateStatus, 60000);

    $("#vehicleOptions").addEventListener("click", e => {
      const b = e.target.closest("[data-vehicle]");
      if (!b) return;
      setVehicle(vehicles.find(v => v.id === b.dataset.vehicle), { flash: true });
    });

    fab.addEventListener("click", () => chat.hidden ? openChat() : closeChat());
    $("#chatClose").addEventListener("click", closeChat);
    addEventListener("keydown", e => { if (e.key === "Escape" && !chat.hidden) closeChat(); });

    document.addEventListener("click", e => {
      const b = e.target.closest("[data-book]");
      if (!b) return;
      e.preventDefault();
      openChat(b.dataset.service || null);
    });

    /* antes/depois */
    const ba = $("#ba");
    if (ba) ba.querySelector("input").addEventListener("input", ev => ba.style.setProperty("--p", ev.target.value + "%"));

    /* header ao rolar */
    const topBar = $("#top");
    const onScroll = () => topBar.classList.toggle("scrolled", window.scrollY > 16);
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });

    /* reveal */
    if ("IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const io = new IntersectionObserver(entries => {
        entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } });
      }, { threshold: 0.12 });
      document.querySelectorAll(".reveal").forEach(el => io.observe(el));
    } else {
      document.querySelectorAll(".reveal").forEach(el => el.classList.add("in"));
    }

    const y = $("#year");
    if (y) y.textContent = new Date().getFullYear();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
