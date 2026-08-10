const state = {
  user: null,
  players: [],
  auction: null,
  roster: null,
  adminRoster: null,
  page: "market",
  playerPage: 1,
  playerPageSize: 20,
  rosterGroup: "position",
  rosterSort: "position-price",
  editingFundsTeamId: null,
  renderedAuctionKey: null,
  poolTab: "queued",
  queueTab: "search",
  queueSelection: null,
  lastSettlementId: null,
  eventSource: null,
  fallbackTimer: null,
  clockTimer: null,
  serverClockAt: 0,
  clockAuctionId: null,
  expiryRefreshId: null,
  toastTimer: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = value => `${Number(value || 0).toLocaleString("zh-CN")} 万`;
const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));

function teamColor(value) {
  const palette = ["#d4a51f", "#287fd1", "#d84b4b", "#31a36b", "#8b5bd6", "#db6d22", "#1aa7a8", "#c33f85", "#6574d8", "#70a22b", "#b54ad1", "#267bb0"];
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric > 0) return palette[(numeric - 1) % palette.length];
  const hash = [...String(value || "球队")].reduce((total, char) => ((total << 5) - total + char.charCodeAt(0)) | 0, 0);
  return palette[Math.abs(hash) % palette.length];
}

function teamAvatar(name, id = "") {
  return `<i class="team-avatar" style="--team-color:${teamColor(id || name)}">${escapeHtml(String(name || "队").slice(0, 1))}</i>`;
}

async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "请求失败");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function toast(message, kind = "") {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show ${kind}`;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => element.className = "toast", 3200);
}

function imageMarkup(player, className = "") {
  const local = escapeHtml(player.photo_path || player.photo_source_url || "");
  const fallback = escapeHtml(player.photo_source_url || "");
  if (!local) return `<div class="${className} photo-placeholder">${escapeHtml(player.name_zh.slice(0, 1))}</div>`;
  return `<img class="${className}" src="${local}" data-fallback="${fallback}" alt="${escapeHtml(player.name_zh)}" onerror="if(this.dataset.fallback&&this.src!==this.dataset.fallback){this.src=this.dataset.fallback}else{this.style.opacity='.15'}">`;
}

function statsMarkup(player, className = "") {
  return `<div class="${className}">${Object.entries(player.stats).map(([label, value]) => `<div><b>${value}</b><span>${label}</span></div>`).join("")}</div>`;
}

function showAuth() {
  stopRealtime();
  $("#auth-page").hidden = false;
  $("#app-shell").hidden = true;
  $("#main-nav").hidden = true;
  $("#user-bar").hidden = true;
}

function showApp() {
  $("#auth-page").hidden = true;
  $("#app-shell").hidden = false;
  $("#main-nav").hidden = false;
  $("#user-bar").hidden = false;
  $$(".admin-only").forEach(element => element.hidden = state.user.role !== "admin");
  $$(".participant-only").forEach(element => element.hidden = state.user.role !== "participant");
  renderUserBar();
  navigate(state.user.role === "admin" && state.page === "lineup" ? "market" : state.page);
  startRealtime();
}

function renderUserBar() {
  const participant = state.user.role === "participant";
  $("#user-bar").innerHTML = `<div class="user-chip">${participant ? teamAvatar(state.user.team_name, state.user.team_id) : teamAvatar("管", "admin")}<div><b>${escapeHtml(state.user.username)}</b><small>${participant ? escapeHtml(state.user.team_name) : "管理员"}</small>${participant ? `<strong class="header-balance">${money(state.user.funds)}</strong>` : ""}</div></div>${participant ? `<button id="edit-team-button" class="link-button">编辑球队名</button>` : ""}<button id="logout-button" class="link-button">退出</button>`;
  $("#logout-button").onclick = logout;
  if (participant) $("#edit-team-button").onclick = openTeamDialog;
}

async function bootstrap() {
  const result = await api("me");
  state.user = result.user;
  if (!state.user) return showAuth();
  showApp();
  await Promise.all([loadPlayers(), refreshAuction()]);
}

function navigate(page) {
  state.page = page;
  $("#app-shell").dataset.page = page;
  $$(".page").forEach(element => element.classList.remove("active-page"));
  $(`#${page}-page`)?.classList.add("active-page");
  $$("#main-nav button").forEach(button => button.classList.toggle("active", button.dataset.page === page));
  window.scrollTo({ top: 0, behavior: "instant" });
  if (page === "players") renderPlayers();
  if (page === "lineup") loadRoster();
  if (page === "admin") loadAdmin();
}

function startRealtime() {
  stopRealtime();
  state.clockTimer = setInterval(updateAuctionClock, 100);
  state.fallbackTimer = setInterval(refreshAuction, 15000);
  if (!("EventSource" in window)) return;
  state.eventSource = new EventSource("/api/events");
  state.eventSource.onopen = () => {
    $("#market-sync").textContent = "实时同步";
    $("#market-sync").classList.add("live");
  };
  state.eventSource.onmessage = () => refreshAuction();
  state.eventSource.onerror = () => {
    $("#market-sync").textContent = "正在重连";
    $("#market-sync").classList.remove("live");
  };
}

function stopRealtime() {
  state.eventSource?.close();
  state.eventSource = null;
  clearInterval(state.fallbackTimer);
  clearInterval(state.clockTimer);
  state.fallbackTimer = null;
  state.clockTimer = null;
}

async function logout() {
  await api("logout", { method: "POST", body: "{}" });
  stopRealtime();
  state.user = null;
  state.auction = null;
  state.roster = null;
  state.renderedAuctionKey = null;
  showAuth();
}

async function loadPlayers() {
  const result = await api("players");
  state.players = result.players;
  populatePlayerFilters();
  renderPlayers();
  renderQueueDialog();
}

function populatePlayerFilters() {
  const fill = (selector, values, label) => {
    const element = $(selector);
    const selected = element.value;
    element.innerHTML = `<option value="">${label}</option>${values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
    element.value = values.includes(selected) ? selected : "";
  };
  fill("#nationality-filter", [...new Set(state.players.map(player => player.nationality).filter(Boolean))].sort(), "全部国籍");
  fill("#club-filter", [...new Set(state.players.map(player => player.club).filter(Boolean))].sort(), "全部俱乐部");
}

function renderPlayers() {
  if (!state.players.length) return;
  const search = $("#player-search").value.trim().toLowerCase();
  const position = $("#position-filter").value;
  const nationality = $("#nationality-filter").value;
  const club = $("#club-filter").value;
  const players = state.players.filter(player => {
    const nameMatch = `${player.name_zh} ${player.name_en} ${player.nationality} ${player.club}`.toLowerCase().includes(search);
    const positionMatch = !position || [player.primary_position, ...player.secondary_positions].includes(position);
    return nameMatch && positionMatch && (!nationality || player.nationality === nationality) && (!club || player.club === club);
  });
  const pages = Math.max(1, Math.ceil(players.length / state.playerPageSize));
  state.playerPage = Math.min(state.playerPage, pages);
  const start = (state.playerPage - 1) * state.playerPageSize;
  const visiblePlayers = players.slice(start, start + state.playerPageSize);
  $("#player-count").textContent = `共 ${players.length} 名 · 第 ${state.playerPage} / ${pages} 页`;
  $("#player-grid").innerHTML = visiblePlayers.map(player => `
    <button class="player-card" data-player-id="${player.id}">
      <div class="player-card-photo">${imageMarkup(player)}</div>
      <span class="player-score">${player.overall}</span><span class="player-position">${escapeHtml(player.primary_position)}</span>
      <span class="player-owner">${escapeHtml(player.team_name || "未归属")}</span>
      <div class="player-card-body"><h3>${escapeHtml(player.name_zh)}</h3><p>${escapeHtml(player.name_en)}</p><div class="player-origin"><span>${escapeHtml(player.nationality || "未知国籍")}</span><span>${escapeHtml(player.club || "未知俱乐部")}</span></div>${statsMarkup(player, "mini-stats")}</div>
    </button>`).join("");
  $$(".player-card", $("#player-grid")).forEach(card => card.onclick = () => openPlayer(card.dataset.playerId));
  $("#player-pagination").innerHTML = `<button data-player-page="${state.playerPage - 1}" ${state.playerPage <= 1 ? "disabled" : ""}>上一页</button><span>${state.playerPage} / ${pages}</span><button data-player-page="${state.playerPage + 1}" ${state.playerPage >= pages ? "disabled" : ""}>下一页</button>`;
  $$('[data-player-page]').forEach(button => button.onclick = () => { state.playerPage = Number(button.dataset.playerPage); renderPlayers(); window.scrollTo({ top: 0, behavior: "smooth" }); });
}

function openPlayer(playerId) {
  const player = state.players.find(item => String(item.id) === String(playerId))
    || state.auction?.active?.player
    || state.roster?.roster.find(item => String(item.player.id) === String(playerId))?.player
    || state.adminRoster?.roster.find(item => String(item.player.id) === String(playerId))?.player;
  if (!player) return;
  const labels = Object.keys(player.stats);
  const values = Object.values(player.stats);
  $("#player-detail").innerHTML = `
    <div class="detail-grid">
      <div class="detail-photo">${imageMarkup(player)}</div>
      <div class="detail-copy"><p class="eyebrow">${escapeHtml(player.category)} · ${escapeHtml(player.primary_position)}</p><h2>${escapeHtml(player.name_zh)}</h2><p>${escapeHtml(player.name_en)}</p>
        ${statsMarkup(player, "detail-stats")}
        <div class="radar-wrap">${radarMarkup(labels, values)}<div class="detail-meta"><span>综合评分 <b>${player.overall}</b></span><span>国籍 / 俱乐部 <b>${escapeHtml(player.nationality || "-")} / ${escapeHtml(player.club || "-")}</b></span><span>身高 / 体重 <b>${player.height_cm || "-"} cm / ${player.weight_kg || "-"} kg</b></span><span>花式 / 逆足 <b>${player.skill_moves}★ / ${player.weak_foot}★</b></span><span>副位置 <b>${escapeHtml(player.secondary_positions.join(" / ") || "无")}</b></span><div class="ability-row">${player.gold_abilities.map(item => `<span class="ability">◆ ${escapeHtml(item)}</span>`).join("")}${player.silver_abilities.map(item => `<span class="ability silver">◇ ${escapeHtml(item)}</span>`).join("")}</div></div></div>
      </div>
    </div>`;
  $("#player-dialog").showModal();
}

function radarMarkup(labels, values) {
  const center = 100, radius = 72;
  const point = (index, scale) => {
    const angle = -Math.PI / 2 + index * Math.PI / 3;
    return `${center + Math.cos(angle) * radius * scale},${95 + Math.sin(angle) * radius * scale}`;
  };
  const grid = [1, .75, .5, .25].map(scale => `<polygon class="grid" points="${labels.map((_, index) => point(index, scale)).join(" ")}"/>`).join("");
  const polygon = labels.map((_, index) => point(index, Number(values[index] || 0) / 100)).join(" ");
  const texts = labels.map((label, index) => {
    const [x, y] = point(index, 1.19).split(",");
    return `<text x="${x}" y="${y}" text-anchor="middle">${label}</text>`;
  }).join("");
  return `<svg class="radar" viewBox="0 0 200 190" aria-label="球员六项能力图">${grid}<polygon class="value" points="${polygon}"/>${texts}</svg>`;
}

async function refreshAuction() {
  if (!state.user) return;
  try {
    const previousActive = state.auction?.active;
    state.auction = await api("auction");
    state.serverClockAt = performance.now();
    if (state.clockAuctionId !== state.auction.active?.id) {
      state.clockAuctionId = state.auction.active?.id || null;
      state.expiryRefreshId = null;
    }
    const currentTeam = state.auction.teams.find(team => team.id === state.user.team_id);
    if (currentTeam && currentTeam.funds !== state.user.funds) {
      state.user.funds = currentTeam.funds;
      renderUserBar();
    }
    if (previousActive && !state.auction.active) {
      const result = state.auction.recent.find(item => item.id === previousActive.id);
      if (result && state.lastSettlementId !== result.id) showSettlement(result);
      const profile = await api("me");
      state.user = profile.user;
      renderUserBar();
      await loadPlayers();
    }
    $("#market-sync").textContent = "实时同步";
    $("#market-sync").classList.add("live");
    renderAuction();
    if (state.user.role === "admin" && state.page === "admin") renderAdminPool();
  } catch (error) {
    if (error.status === 401) {
      stopRealtime();
      state.user = null;
      state.auction = null;
      state.renderedAuctionKey = null;
      showAuth();
      toast("登录已失效，请重新登录", "error");
      return;
    }
    $("#market-sync").textContent = "连接中断";
    $("#market-sync").classList.remove("live");
  }
}

function renderAuction() {
  const { active, queued, server_time: serverTime } = state.auction;
  renderAuctionPool();
  if (!active) {
    if (state.renderedAuctionKey !== "empty") {
      $("#auction-player-card").className = "auction-player-card empty-player-card";
      $("#auction-player-card").innerHTML = `<div><span>NO ACTIVE LOT</span><strong>等待拍品</strong><small>管理员开启竞拍后，球员完整信息会显示在这里。</small></div>`;
      $("#auction-stage").className = "auction-stage empty-stage";
      $("#auction-stage").innerHTML = `<div class="waiting-stage"><p class="eyebrow">WAITING ROOM</p><h2>等待管理员开启下一场竞拍</h2><p id="waiting-pool-count"></p></div>`;
      state.renderedAuctionKey = "empty";
    }
    $("#waiting-pool-count").textContent = `拍卖池中还有 ${queued.length} 名球员`;
    renderBidSeats([], state.auction.teams || []);
    renderBidHistory([]);
    $("#bid-count").textContent = "0 次报价";
    return;
  }
  const player = active.player;
  const canBid = state.user.role === "participant";
  const sealed = active.auction_type === "sealed";
  const topBid = active.bids[0]?.amount;
  const minimum = sealed || topBid == null ? active.start_price : topBid + active.min_increment;
  const renderKey = `${active.id}:${active.auction_type}:${canBid}:${sealed && active.has_bid}`;
  if (state.renderedAuctionKey !== renderKey) {
    $("#auction-player-card").className = "auction-player-card";
    $("#auction-player-card").innerHTML = playerShowcaseMarkup(player);
    $("#auction-player-card").onclick = () => openPlayer(player.id);
    $("#auction-stage").className = `auction-stage ${sealed ? "sealed-stage" : ""}`;
    $("#auction-stage").innerHTML = `
      <div class="auction-mode"><span class="active">${sealed ? "暗拍" : "明拍"}</span><span>${sealed ? "一次密封报价" : "公开实时竞价"}</span></div>
      <div class="countdown-orbit"><div><small>剩余时间</small><strong id="countdown">00:00</strong><span id="countdown-hint"></span></div></div>
      <div class="live-price"><small>${sealed ? "已提交球队" : "当前最高价"}</small><strong id="live-price-value"></strong><span id="live-price-leader"></span></div>
      ${bidComposerMarkup(active, canBid, minimum)}
      <p id="bid-guidance" class="spectator-note"></p>`;
    bindBidComposer(active);
    state.renderedAuctionKey = renderKey;
  }
  updateAuctionStage(active, serverTime, minimum);
  if (sealed) {
    renderSealedStatus(active, state.auction.teams || []);
  } else {
    renderBidSeats(active.bids, state.auction.teams || []);
    renderBidHistory(active.bids);
  }
}

function bidComposerMarkup(active, canBid, minimum) {
  if (!canBid) return "";
  if (active.auction_type === "sealed" && active.has_bid) {
    return `<div class="sealed-submitted"><b>报价已密封提交</b><span>本轮不能修改或再次报价</span></div>`;
  }
  const step = active.auction_type === "sealed" ? 10 : active.min_increment;
  return `<form id="bid-form" class="bid-composer">
    <div class="bid-input-row"><button type="button" data-bid-adjust="-${step}" aria-label="减少报价">−</button><label><span>我的报价（万）</span><input name="amount" type="number" min="${minimum}" value="${minimum}" step="1" required></label><button type="button" data-bid-adjust="${step}" aria-label="增加报价">＋</button></div>
    <div class="bid-quick-row"><button type="button" data-bid-add="10">＋10 万</button><button type="button" data-bid-add="50">＋50 万</button><button type="button" data-bid-add="100">＋100 万</button></div>
    <button class="primary-button bid-submit" type="submit">${active.auction_type === "sealed" ? "密封提交唯一报价" : "举牌确认报价"}</button>
  </form>`;
}

function bindBidComposer(active) {
  const form = $("#bid-form");
  if (!form) return;
  form.onsubmit = submitBid;
  const input = $("input[name=amount]", form);
  $$('[data-bid-adjust]', form).forEach(button => button.onclick = () => {
    input.value = Math.max(Number(input.min), Number(input.value || input.min) + Number(button.dataset.bidAdjust));
    input.dispatchEvent(new Event("input"));
  });
  $$('[data-bid-add]', form).forEach(button => button.onclick = () => {
    input.value = Number(input.value || input.min) + Number(button.dataset.bidAdd);
    input.dispatchEvent(new Event("input"));
  });
  input.oninput = () => input.classList.toggle("invalid", Number(input.value) < Number(input.min));
}

function updateAuctionStage(active, serverTime, minimum) {
  updateCountdown(active, serverTime);
  if (active.auction_type === "sealed") {
    $("#live-price-value").textContent = `${active.bid_count} / ${state.auction.teams.length}`;
    $("#live-price-leader").textContent = "报价金额将在结束后揭晓";
    $("#bid-guidance").textContent = state.user.role === "participant" ? (active.has_bid ? "你的唯一报价已提交" : `最低报价 ${money(minimum)} · 可用余额 ${money(state.user.funds)}`) : `暗拍进行中 · 已有 ${active.bid_count} 支球队提交`;
  } else {
    const topBid = active.bids[0];
    const ownLeader = state.user.role === "participant" && topBid?.team_id === state.user.team_id;
    $("#live-price-value").textContent = money(topBid?.amount ?? active.start_price);
    $("#live-price-leader").textContent = topBid ? topBid.team_name : "等待第一份报价";
    $("#bid-guidance").textContent = state.user.role === "participant" ? (ownLeader ? "你正在领先 · 其他球队报价前不能继续自我加价" : `当前最低有效报价 ${money(minimum)} · 可用余额 ${money(state.user.funds)}`) : "管理员视角 · 所有参与者报价正在实时同步";
    const form = $("#bid-form");
    if (form) {
      form.classList.toggle("bid-locked", ownLeader);
      $$("button,input", form).forEach(control => control.disabled = ownLeader);
      $(".bid-submit", form).textContent = ownLeader ? "当前最高报价" : "举牌确认报价";
    }
  }
  const input = $("#bid-form input[name=amount]");
  if (input) {
    input.min = minimum;
    input.classList.toggle("invalid", Number(input.value) < minimum);
  }
}

function updateCountdown(active, serverTime) {
  const countdown = $("#countdown");
  const orbit = $(".countdown-orbit", $("#auction-stage"));
  if (!countdown || !orbit) return;
  const remaining = Math.max(0, active.ends_at - serverTime);
  const progress = Math.max(0, Math.min(1, remaining / active.duration_seconds));
  countdown.textContent = formatCountdown(remaining);
  $("#countdown-hint").textContent = remaining <= 10 ? "即将落槌" : "有效报价后重新计时";
  orbit.style.setProperty("--progress", progress);
}

function updateAuctionClock() {
  const active = state.auction?.active;
  if (!active || !state.serverClockAt) return;
  const serverTime = state.auction.server_time + (performance.now() - state.serverClockAt) / 1000;
  updateCountdown(active, serverTime);
  if (serverTime >= active.ends_at && state.expiryRefreshId !== active.id) {
    state.expiryRefreshId = active.id;
    refreshAuction();
  }
}

function renderSealedStatus(active, teams) {
  $("#bid-count").textContent = `${active.bid_count} 支球队已报价`;
  $("#bid-ranking").innerHTML = `<div class="sealed-progress"><strong>${active.bid_count}</strong><span>/ ${teams.length} 支球队已完成密封报价</span><div><i style="width:${teams.length ? active.bid_count / teams.length * 100 : 0}%"></i></div><small>竞拍结束前不会公开球队和金额</small></div>`;
  $("#bid-history").innerHTML = `<div class="sealed-lock"><b>报价已加密隐藏</b><span>结束后仅揭晓中标球队与成交价</span></div>`;
}

function playerShowcaseMarkup(player) {
  return `<div class="showcase-head"><div><strong>${player.overall}</strong><span>${escapeHtml(player.primary_position)}</span></div><em>${escapeHtml(player.category)}</em></div>
    <div class="showcase-photo">${imageMarkup(player)}<span class="showcase-role">${escapeHtml((player.roles || []).slice(0, 2).join(" · ") || player.primary_position)}</span><span class="showcase-physical">${player.height_cm || "-"} cm · ${player.weight_kg || "-"} kg</span></div>
    <div class="showcase-name"><small>${escapeHtml(player.name_en)}</small><h2>${escapeHtml(player.name_zh)}</h2><p>${escapeHtml(player.nationality || "-")} · ${escapeHtml(player.club || "-")}</p></div>
    <div class="showcase-data">${radarMarkup(Object.keys(player.stats), Object.values(player.stats))}${statsMarkup(player, "showcase-stats")}</div>
    <div class="showcase-traits"><span>花式 ${player.skill_moves}★</span><span>逆足 ${player.weak_foot}★</span>${player.gold_abilities.slice(0, 2).map(value => `<b>◆ ${escapeHtml(value)}</b>`).join("")}${player.silver_abilities.slice(0, 2).map(value => `<b class="silver">◇ ${escapeHtml(value)}</b>`).join("")}</div>`;
}

function formatCountdown(seconds) {
  const safe = Math.ceil(Math.max(0, seconds));
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function renderBidSeats(bids, teams) {
  const bestByTeam = new Map();
  bids.forEach(bid => { if (!bestByTeam.has(bid.team_id)) bestByTeam.set(bid.team_id, bid); });
  $("#bid-count").textContent = `${bids.length} 次报价`;
  const leaderId = bids[0]?.team_id;
  $("#bid-ranking").innerHTML = teams.length ? teams.map(team => {
    const bid = bestByTeam.get(team.id);
    return `<div class="seat-card ${leaderId === team.id ? "leader" : ""}">${teamAvatar(team.name, team.id)}<div><b>${escapeHtml(team.name)}</b><small>${bid ? `${new Date(bid.created_at * 1000).toLocaleTimeString("zh-CN")} 出价` : "等待出价"}</small><span>余额 <strong>${money(team.funds)}</strong></span></div><strong>${bid ? money(bid.amount) : "—"}</strong>${leaderId === team.id ? `<em>领先</em>` : ""}</div>`;
  }).join("") : `<div class="empty-copy">参与者创建球队后会出现在竞价席</div>`;
}

function renderBidHistory(bids) {
  $("#bid-history").innerHTML = bids.length ? bids.map((bid, index) => `<div class="history-row"><span>${String(index + 1).padStart(2, "0")}</span><div><b>${escapeHtml(bid.team_name)}</b><small>${new Date(bid.created_at * 1000).toLocaleTimeString("zh-CN")}</small></div><strong>${money(bid.amount)}</strong></div>`).join("") : `<div class="empty-copy">报价记录会按价格显示</div>`;
}

async function submitBid(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("button[type=submit]", form);
  button.disabled = true;
  try {
    const amount = Number(new FormData(event.currentTarget).get("amount"));
    await api("bid", { method: "POST", body: JSON.stringify({ amount }) });
    toast(state.auction.active.auction_type === "sealed" ? "暗拍报价已密封提交" : `报价 ${money(amount)} 已进入竞价席`);
    await refreshAuction();
    const input = $("#bid-form input[name=amount]");
    if (input && state.auction.active?.auction_type === "open") input.value = input.min;
  } catch (error) {
    await refreshAuction();
    toast(error.message, "error");
  } finally {
    if (button.isConnected) button.disabled = form.classList.contains("bid-locked");
  }
}

function poolCard(item) {
  const player = item.player;
  return `<div class="pool-card">${imageMarkup(player)}<div><b>${escapeHtml(player.name_zh)}</b><small>${item.auction_type === "sealed" ? "暗拍" : "明拍"} · ${player.overall} · ${escapeHtml(player.primary_position)} · 起拍 ${money(item.start_price)}</small></div><span>#${item.id}</span></div>`;
}

function resultCard(item) {
  return `<div class="result-card">${imageMarkup(item.player)}<div><b>${escapeHtml(item.player.name_zh)}</b><small>${item.status === "sold" ? escapeHtml(item.winner_team_name) : "流拍"}</small></div><span class="result-status">${item.status === "sold" ? money(item.final_price) : "UNSOLD"}</span></div>`;
}

function renderAuctionPool() {
  const { queued, recent } = state.auction;
  const collections = {
    queued,
    sold: recent.filter(item => item.status === "sold"),
    unsold: recent.filter(item => item.status === "unsold"),
  };
  const items = collections[state.poolTab];
  $("#pool-count").textContent = `${items.length} 人`;
  $("#auction-pool").innerHTML = items.length
    ? items.map(item => state.poolTab === "queued" ? poolCard(item) : resultCard(item)).join("")
    : `<div class="empty-copy">${state.poolTab === "queued" ? "拍卖池还是空的" : "暂无记录"}</div>`;
  $$('[data-pool-tab]').forEach(button => button.classList.toggle("active", button.dataset.poolTab === state.poolTab));
}

function showSettlement(result) {
  state.lastSettlementId = result.id;
  const sold = result.status === "sold";
  $("#settlement-content").innerHTML = `<p class="eyebrow">本轮${result.auction_type === "sealed" ? "暗拍" : "竞拍"}${sold ? "成交" : "结束"}</p><h2>${sold ? "拍 中" : "流 拍"}</h2>${sold ? `<div class="settlement-team">${teamAvatar(result.winner_team_name, result.winner_team_id)}<strong>${escapeHtml(result.winner_team_name)}</strong></div>` : ""}<p>${escapeHtml(result.player.name_zh)}${sold ? ` · ${money(result.final_price)}` : " · 无人出价"}</p>`;
  $("#settlement-dialog").showModal();
}

async function loadRoster() {
  if (state.user.role !== "participant") return;
  try {
    state.roster = await api("roster");
    $("#lineup-title").textContent = state.roster.team.name;
    $("#lineup-budget").innerHTML = `<small>AVAILABLE BUDGET</small><b>${money(state.roster.team.funds)}</b>`;
    renderRoster();
  } catch (error) { toast(error.message, "error"); }
}

function renderRoster() {
  const positionOrder = ["GK", "CB", "LB", "RB", "CDM", "CM", "CAM", "LM", "RM", "LW", "RW", "ST"];
  const items = [...state.roster.roster].sort((left, right) => {
    if (state.rosterSort === "price-desc") return right.acquired_price - left.acquired_price;
    if (state.rosterSort === "price-asc") return left.acquired_price - right.acquired_price;
    if (state.rosterSort === "nationality") return String(left.player.nationality).localeCompare(String(right.player.nationality), "zh-CN") || right.acquired_price - left.acquired_price;
    return positionOrder.indexOf(left.player.primary_position) - positionOrder.indexOf(right.player.primary_position) || right.acquired_price - left.acquired_price;
  });
  const groups = new Map();
  items.forEach(item => {
    const label = state.rosterGroup === "nationality" ? (item.player.nationality || "未知国籍") : state.rosterGroup === "position" ? item.player.primary_position : "全部球员";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  });
  $("#roster-list").innerHTML = items.length ? [...groups].map(([label, players]) => `<section class="roster-group"><header><h2>${escapeHtml(label)}</h2><span>${players.length} 人</span></header><div class="roster-cards">${players.map(rosterCardMarkup).join("")}</div></section>`).join("") : `<div class="empty-copy roster-empty">成交球员会出现在这里</div>`;
  $$("[data-player-id]", $("#roster-list")).forEach(element => element.onclick = () => openPlayer(element.dataset.playerId));
}

function rosterCardMarkup(item) {
  const player = item.player;
  return `<button class="roster-list-card" data-player-id="${player.id}">${imageMarkup(player)}<span class="roster-rating">${player.overall}</span><div><small>${escapeHtml(player.primary_position)} · ${escapeHtml(player.category)}</small><b>${escapeHtml(player.name_zh)}</b><p>${escapeHtml(player.nationality || "-")} · ${escapeHtml(player.club || "-")}</p></div><strong>${money(item.acquired_price)}</strong><em>查看详情</em></button>`;
}

function fieldPlayer(item, index, starters) {
  const positions = fieldCoordinates(item.player.primary_position, index, starters);
  return `<button class="field-player" data-player-id="${item.player.id}" style="left:${positions.x}%;top:${positions.y}%">${imageMarkup(item.player)}<b>${escapeHtml(item.player.name_zh)}</b><small>${item.player.overall} · ${escapeHtml(item.player.primary_position)}</small></button>`;
}

function fieldCoordinates(position, index, starters) {
  const lines = { GK: 88, CB: 72, LB: 69, RB: 69, CDM: 58, CM: 49, CAM: 40, LM: 36, RM: 36, LW: 22, RW: 22, ST: 16 };
  const y = lines[position] ?? 50;
  const sameLine = starters.filter(item => (lines[item.player.primary_position] ?? 50) === y);
  const lineIndex = sameLine.findIndex(item => item.player.id === starters[index].player.id);
  const x = 100 / (sameLine.length + 1) * (lineIndex + 1);
  return { x, y };
}

async function toggleLineup(playerId) {
  try {
    await api("lineup/toggle", { method: "POST", body: JSON.stringify({ player_id: playerId }) });
    await loadRoster();
    window.scrollTo({ top: 0, behavior: "instant" });
  } catch (error) { toast(error.message, "error"); }
}

function openTeamDialog() {
  $("#team-name-input").value = state.user.team_name;
  $("#team-dialog").showModal();
}

async function saveTeamName(event) {
  event.preventDefault();
  try {
    const name = $("#team-name-input").value.trim();
    await api("team/name", { method: "POST", body: JSON.stringify({ name }) });
    state.user = (await api("me")).user;
    renderUserBar();
    $("#team-dialog").close();
    toast("球队名称已更新");
    if (state.page === "lineup") await loadRoster();
  } catch (error) { toast(error.message, "error"); }
}

function availableQueuePlayers() {
  const blocked = new Set((state.auction?.queued || []).map(item => String(item.player_id)));
  if (state.auction?.active) blocked.add(String(state.auction.active.player_id));
  return state.players.filter(player => !player.owned && !blocked.has(String(player.id)));
}

function renderQueueDialog() {
  if (state.user?.role !== "admin" || !$("#queue-dialog") || !state.players.length) return;
  const categories = [...new Set(state.players.map(player => player.category).filter(Boolean))].sort();
  const categorySelect = $("#random-category");
  const currentCategory = categorySelect.value;
  categorySelect.innerHTML = `<option value="">全部类别</option>${categories.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
  categorySelect.value = categories.includes(currentCategory) ? currentCategory : "";
  renderQueueSearch();
  renderRandomOptions();
}

function renderQueueSearch() {
  const available = availableQueuePlayers();
  const query = $("#queue-search").value.trim().toLowerCase();
  const matches = available.filter(player => `${player.name_zh} ${player.name_en}`.toLowerCase().includes(query));
  $("#queue-available-count").textContent = `${matches.length} 名可上架`;
  $("#queue-player-grid").innerHTML = matches.length ? matches.map(player => `<button type="button" class="queue-player-card ${String(state.queueSelection?.id) === String(player.id) ? "selected" : ""}" data-queue-player="${player.id}">${imageMarkup(player)}<span><b>${escapeHtml(player.name_zh)}</b><small>${player.overall} · ${escapeHtml(player.primary_position)} · ${escapeHtml(player.category)}</small></span><em>${String(state.queueSelection?.id) === String(player.id) ? "已选择" : "选择"}</em></button>`).join("") : `<div class="empty-copy">没有符合条件的球员</div>`;
  $$('[data-queue-player]', $("#queue-player-grid")).forEach(button => button.onclick = () => selectQueuePlayer(button.dataset.queuePlayer));
}

function randomCandidates() {
  const minimum = Number($("#random-min-rating").value || 0);
  const maximum = Number($("#random-max-rating").value || 99);
  const position = $("#random-position").value;
  const category = $("#random-category").value;
  return availableQueuePlayers().filter(player => player.overall >= minimum && player.overall <= maximum && (!position || player.primary_position === position) && (!category || player.category === category));
}

function renderRandomOptions() {
  $("#random-match-count").textContent = randomCandidates().length;
  $("#draw-player").disabled = randomCandidates().length === 0;
}

function selectQueuePlayer(playerId) {
  const player = availableQueuePlayers().find(item => String(item.id) === String(playerId));
  if (!player) return;
  state.queueSelection = player;
  $("#queue-player").value = player.id;
  $("#queue-submit").disabled = false;
  $("#queue-submit").textContent = `将 ${player.name_zh} 加入拍卖池`;
  $("#random-preview").innerHTML = `<div class="random-player-reveal">${imageMarkup(player)}<span><small>${escapeHtml(player.category)} · ${escapeHtml(player.primary_position)}</small><strong>${escapeHtml(player.name_zh)}</strong><em>${player.overall}</em></span></div>`;
  renderQueueSearch();
}

function secureRandomIndex(length) {
  const range = 0x100000000;
  const ceiling = Math.floor(range / length) * length;
  const bucket = new Uint32Array(1);
  do { crypto.getRandomValues(bucket); } while (bucket[0] >= ceiling);
  return bucket[0] % length;
}

function drawRandomPlayer() {
  const candidates = randomCandidates();
  if (!candidates.length) return toast("当前条件下没有可上架球员", "error");
  selectQueuePlayer(candidates[secureRandomIndex(candidates.length)].id);
}

function openQueueDialog() {
  state.queueSelection = null;
  $("#queue-player").value = "";
  $("#queue-submit").disabled = true;
  $("#queue-submit").textContent = "加入拍卖池";
  $("#random-preview").innerHTML = `<span>点击下方按钮抽取一名球员</span>`;
  renderQueueDialog();
  $("#queue-dialog").showModal();
}

function switchQueueTab(tab) {
  state.queueTab = tab;
  $$('[data-queue-tab]').forEach(button => button.classList.toggle("active", button.dataset.queueTab === tab));
  $("#queue-search-panel").hidden = tab !== "search";
  $("#queue-random-panel").hidden = tab !== "random";
}

async function loadAdmin() {
  if (state.user.role !== "admin") return;
  try {
    const result = await api("admin/teams");
    $("#admin-teams").innerHTML = result.teams.length ? result.teams.map(adminTeamMarkup).join("") : `<div class="empty-copy">参与者注册后会出现在这里</div>`;
    $$('[data-save-funds]').forEach(button => button.onclick = () => saveFunds(button.dataset.saveFunds));
    $$('[data-edit-funds]').forEach(button => button.onclick = () => { state.editingFundsTeamId = Number(button.dataset.editFunds); loadAdmin(); });
    $$('[data-cancel-funds]').forEach(button => button.onclick = () => { state.editingFundsTeamId = null; loadAdmin(); });
    $$('[data-view-roster]').forEach(button => button.onclick = () => openAdminRoster(button.dataset.viewRoster));
    $$('[data-release-participant]').forEach(button => button.onclick = () => releaseParticipant(button.dataset.releaseParticipant));
    renderAdminPool();
  } catch (error) { toast(error.message, "error"); }
}

function adminTeamMarkup(team) {
  const editing = state.editingFundsTeamId === team.id;
  return `<div class="admin-team-row"><div class="admin-team-identity">${teamAvatar(team.name, team.id)}<span><b>${escapeHtml(team.name)}</b><small>${team.username ? `账号：${escapeHtml(team.username)}` : "账号已释放"}</small></span></div>${editing ? `<input class="funds-editor" type="number" min="0" value="${team.funds}" data-funds-team="${team.id}">` : `<div class="funds-readout"><small>当前资金</small><strong>${money(team.funds)}</strong></div>`}<div class="admin-team-actions">${editing ? `<button data-save-funds="${team.id}">保存资金</button><button class="secondary-action" data-cancel-funds="${team.id}">取消</button>` : `<button data-edit-funds="${team.id}">编辑资金</button>`}<button class="secondary-action" data-view-roster="${team.id}">查看阵容</button>${team.participant_user_id ? `<button class="danger-action" data-release-participant="${team.id}">释放账号</button>` : ""}</div></div>`;
}

async function openAdminRoster(teamId) {
  try {
    state.adminRoster = await api(`roster?team_id=${encodeURIComponent(teamId)}`);
    renderAdminRoster();
    $("#admin-roster-dialog").showModal();
  } catch (error) { toast(error.message, "error"); }
}

function renderAdminRoster() {
  const { team, roster } = state.adminRoster;
  const starters = roster.filter(item => item.lineup_role === "starter");
  const bench = roster.filter(item => item.lineup_role === "bench");
  $("#admin-roster-detail").innerHTML = `
    <header class="admin-roster-header">
      <div><p class="eyebrow">TEAM SQUAD · READ ONLY</p><h2>${escapeHtml(team.name)}</h2><span>管理员只读查看，阵容调整仍由参与者完成</span></div>
      <div class="admin-roster-summary"><span><small>剩余资金</small><b>${money(team.funds)}</b></span><span><small>球员</small><b>${roster.length}</b></span><span><small>首发 / 替补</small><b>${starters.length} / ${bench.length}</b></span></div>
    </header>
    <div class="admin-roster-layout">
      <section class="pitch-panel">
        <div class="pitch"><div class="pitch-line center-line"></div><div class="pitch-circle"></div><div class="penalty top"></div><div class="penalty bottom"></div>${starters.length ? starters.map((item, index) => fieldPlayer(item, index, starters)).join("") : `<div class="admin-empty-pitch">暂无首发球员</div>`}</div>
      </section>
      <section class="panel admin-roster-bench-panel"><header><div><p class="eyebrow">SUBSTITUTES</p><h2>替补席</h2></div><span>点击查看球员详情</span></header><div class="bench">${bench.length ? bench.map(item => `<button class="bench-player" data-player-id="${item.player.id}">${imageMarkup(item.player)}<span><b>${escapeHtml(item.player.name_zh)}</b><small>${item.player.overall} · ${escapeHtml(item.player.primary_position)} · ${money(item.acquired_price)}</small></span><em>查看详情</em></button>`).join("") : `<div class="empty-copy">暂无替补球员</div>`}</div></section>
    </div>`;
  $$('[data-player-id]', $("#admin-roster-detail")).forEach(element => element.onclick = () => openPlayer(element.dataset.playerId));
}

async function saveFunds(teamId) {
  const funds = Number($(`[data-funds-team="${teamId}"]`).value);
  try {
    await api("admin/funds", { method: "POST", body: JSON.stringify({ team_id: Number(teamId), funds }) });
    state.editingFundsTeamId = null;
    toast("球队资金已更新");
    await loadAdmin();
  } catch (error) { toast(error.message, "error"); }
}

async function releaseParticipant(teamId) {
  const row = $(`[data-release-participant="${teamId}"]`)?.closest(".admin-team-row");
  const teamName = $(".admin-team-identity b", row)?.textContent || `球队 #${teamId}`;
  if (!window.confirm(`确认释放“${teamName}”的参与者账号？该账号会立即退出登录，球队、阵容和竞拍记录会保留。`)) return;
  try {
    await api("admin/participant/release", { method: "POST", body: JSON.stringify({ team_id: Number(teamId) }) });
    toast("参与者账号已释放");
    await loadAdmin();
  } catch (error) { toast(error.message, "error"); }
}

function renderAdminPool() {
  if (!state.auction) return;
  const active = state.auction.active;
  $("#admin-pool-list").innerHTML = `${active ? `<div class="admin-pool-row">${imageMarkup(active.player)}<div><b>${escapeHtml(active.player.name_zh)}</b><small>${active.auction_type === "sealed" ? "暗拍" : "明拍"}进行中 · ${active.auction_type === "sealed" ? active.bid_count : active.bids.length} ${active.auction_type === "sealed" ? "支球队已报价" : "次报价"}</small></div><span>${active.auction_type === "sealed" ? "金额保密" : money(active.bids[0]?.amount ?? active.start_price)}</span><button disabled>进行中</button></div>` : ""}${state.auction.queued.map(item => `<div class="admin-pool-row">${imageMarkup(item.player)}<div><b>${escapeHtml(item.player.name_zh)}</b><small>${item.auction_type === "sealed" ? "暗拍" : "明拍"} · ${item.duration_seconds} 秒 · 起拍 ${money(item.start_price)}${item.auction_type === "open" ? ` · 每次 +${money(item.min_increment)}` : ""}</small></div><span>#${item.id}</span><button data-start-auction="${item.id}" ${active ? "disabled" : ""}>开始竞拍</button></div>`).join("") || (!active ? `<div class="empty-copy">先把球员加入拍卖池</div>` : "")}`;
  $$('[data-start-auction]').forEach(button => button.onclick = () => startAuction(button.dataset.startAuction));
  if (!$("#queue-dialog").open) renderQueueDialog();
}

async function startAuction(auctionId) {
  try {
    await api("admin/auction/start", { method: "POST", body: JSON.stringify({ auction_id: Number(auctionId) }) });
    toast("竞拍已开始，参与者端正在同步");
    navigate("market");
    await refreshAuction();
  } catch (error) { toast(error.message, "error"); }
}

async function queueAuction(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  ["start_price", "min_increment", "duration_seconds"].forEach(key => data[key] = Number(data[key]));
  try {
    await api("admin/auction/queue", { method: "POST", body: JSON.stringify(data) });
    toast("球员已加入拍卖池");
    $("#queue-dialog").close();
    state.queueSelection = null;
    await Promise.all([loadPlayers(), refreshAuction()]);
    renderAdminPool();
  } catch (error) { toast(error.message, "error"); }
}

$$('[data-auth]').forEach(button => button.onclick = () => {
  $$('[data-auth]').forEach(item => item.classList.toggle("active", item === button));
  $("#login-form").hidden = button.dataset.auth !== "login";
  $("#register-form").hidden = button.dataset.auth !== "register";
});
$("#login-form").onsubmit = async event => {
  event.preventDefault();
  try {
    await api("login", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    await bootstrap();
  } catch (error) { toast(error.message, "error"); }
};
$("#register-form").onsubmit = async event => {
  event.preventDefault();
  try {
    await api("register", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    toast("球队和账号已创建，请登录");
    $('[data-auth="login"]').click();
    $("#login-form [name=username]").value = new FormData(event.currentTarget).get("username");
    event.currentTarget.reset();
  } catch (error) { toast(error.message, "error"); }
};
$$('#main-nav button').forEach(button => button.onclick = () => navigate(button.dataset.page));
[$("#position-filter"), $("#nationality-filter"), $("#club-filter")].forEach(element => element.onchange = () => { state.playerPage = 1; renderPlayers(); });
$("#player-search").oninput = () => { state.playerPage = 1; renderPlayers(); };
$("#roster-group").onchange = event => { state.rosterGroup = event.currentTarget.value; renderRoster(); };
$("#roster-sort").onchange = event => { state.rosterSort = event.currentTarget.value; renderRoster(); };
$("#queue-form").onsubmit = queueAuction;
$("#open-queue-dialog").onclick = openQueueDialog;
$("#market-queue-shortcut").onclick = openQueueDialog;
$("#queue-dialog .dialog-close").onclick = () => $("#queue-dialog").close();
$("#queue-dialog").onclick = event => { if (event.target === $("#queue-dialog")) $("#queue-dialog").close(); };
$$('[data-queue-tab]').forEach(button => button.onclick = () => switchQueueTab(button.dataset.queueTab));
$("#queue-search").oninput = renderQueueSearch;
[$("#random-min-rating"), $("#random-max-rating"), $("#random-position"), $("#random-category")].forEach(element => {
  element.oninput = renderRandomOptions;
  element.onchange = renderRandomOptions;
});
$("#draw-player").onclick = drawRandomPlayer;
$("#auction-type").onchange = event => {
  const sealed = event.currentTarget.value === "sealed";
  $("#increment-rule").classList.toggle("rule-muted", sealed);
};
$$('[data-pool-tab]').forEach(button => button.onclick = () => { state.poolTab = button.dataset.poolTab; renderAuctionPool(); });
$("#settlement-close").onclick = () => $("#settlement-dialog").close();
$("#settlement-dialog").onclick = event => { if (event.target === $("#settlement-dialog")) $("#settlement-dialog").close(); };
$("#player-dialog .dialog-close").onclick = () => $("#player-dialog").close();
$("#player-dialog").onclick = event => { if (event.target === $("#player-dialog")) $("#player-dialog").close(); };
$("#admin-roster-dialog .dialog-close").onclick = () => $("#admin-roster-dialog").close();
$("#admin-roster-dialog").onclick = event => { if (event.target === $("#admin-roster-dialog")) $("#admin-roster-dialog").close(); };
$("#team-name-form").onsubmit = saveTeamName;
$("#team-dialog .dialog-close").onclick = () => $("#team-dialog").close();
$("#team-dialog").onclick = event => { if (event.target === $("#team-dialog")) $("#team-dialog").close(); };

bootstrap().catch(error => toast(error.message, "error"));
