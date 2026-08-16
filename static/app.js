const state = {
  user: null,
  players: [],
  auction: null,
  auctionHistory: [],
  reviewAuctionId: null,
  roster: null,
  adminRoster: null,
  trades: [],
  tradeOptions: [],
  tradePartyCount: 2,
  tradeSelectedTeamIds: [],
  matchData: { matches: [], standings: [], leaders: { scorers: [], assists: [] }, teams: [] },
  editingMatchId: null,
  matchStatMatchId: null,
  matchStatSideTeamId: null,
  matchStatDraft: [],
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
  queueStartImmediately: false,
  drawingPlayer: false,
  drawRevealToken: 0,
  pendingBid: null,
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
  navigate(state.user.role === "admin" && ["lineup", "trades"].includes(state.page) ? "market" : state.page);
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
  if (page === "matches") loadMatches();
  if (page === "history") loadAuctionHistory();
  if (page === "lineup") loadRoster();
  if (page === "trades") loadTradeCenter();
  if (page === "admin") loadAdmin();
}

function startRealtime() {
  stopRealtime();
  state.clockTimer = setInterval(updateAuctionClock, 100);
  state.fallbackTimer = setInterval(refreshAuction, 3000);
  if (!("EventSource" in window)) return;
  state.eventSource = new EventSource("/api/events");
  state.eventSource.onopen = () => {
    $("#market-sync").textContent = "实时同步";
    $("#market-sync").classList.add("live");
  };
  state.eventSource.onmessage = () => {
    refreshAuction();
    if (state.page === "trades" && state.user?.role === "participant") refreshTrades();
    if (state.page === "matches") loadMatches(true);
  };
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
  state.auctionHistory = [];
  state.reviewAuctionId = null;
  state.roster = null;
  state.trades = [];
  state.tradeOptions = [];
  state.matchData = { matches: [], standings: [], leaders: { scorers: [], assists: [] }, teams: [] };
  state.editingMatchId = null;
  state.matchStatMatchId = null;
  state.matchStatDraft = [];
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

function playerPerformance(playerId) {
  const records = (state.matchData.matches || []).flatMap(match => {
    const stat = (match.player_stats || []).find(item => String(item.player_id) === String(playerId));
    if (!stat) return [];
    const isHome = Number(stat.team_id) === Number(match.home_team_id);
    return [{
      ...stat,
      match_id: match.id,
      opponent: isHome ? match.away_team_name : match.home_team_name,
      score: `${match.home_score} : ${match.away_score}`,
      played_at: match.played_at,
      round_name: match.stage === "group" ? `${match.group_name} · ${match.round_name}` : match.round_name,
    }];
  });
  return {
    records,
    goals: records.reduce((total, item) => total + item.goals, 0),
    assists: records.reduce((total, item) => total + item.assists, 0),
  };
}

function performanceMarkup(performance) {
  const records = performance.records.map(item => `<div class="player-performance-row"><time>${item.played_at ? new Date(item.played_at * 1000).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "日期待定"}</time><span><b>${escapeHtml(item.team_name)} vs ${escapeHtml(item.opponent)}</b><small>${escapeHtml(item.round_name)} · ${item.score}</small></span><strong>${item.goals ? `⚽ ${item.goals}` : ""}${item.assists ? `<em>助 ${item.assists}</em>` : ""}</strong></div>`).join("");
  return `<section class="player-performance"><header><div><p class="eyebrow">HCDM CUP RECORD</p><h3>赛事进球与助攻</h3></div><div class="player-performance-totals"><span><small>出场记录</small><b>${performance.records.length}</b></span><span><small>进球</small><b>${performance.goals}</b></span><span><small>助攻</small><b>${performance.assists}</b></span></div></header>${records ? `<div class="player-performance-list">${records}</div>` : `<div class="empty-copy player-performance-empty">暂无进球或助攻记录</div>`}</section>`;
}

async function openPlayer(playerId) {
  const player = state.players.find(item => String(item.id) === String(playerId))
    || state.auction?.active?.player
    || state.auctionHistory.find(item => String(item.player.id) === String(playerId))?.player
    || state.roster?.roster.find(item => String(item.player.id) === String(playerId))?.player
    || state.adminRoster?.roster.find(item => String(item.player.id) === String(playerId))?.player;
  if (!player) return;
  if (state.user && !state.matchData.teams.length) {
    try { state.matchData = await api("matches"); } catch (_) { /* 球员基础资料仍可独立查看。 */ }
  }
  const performance = playerPerformance(player.id);
  const labels = Object.keys(player.stats);
  const values = Object.values(player.stats);
  $("#player-detail").innerHTML = `
    <div class="detail-grid">
      <div class="detail-photo">${imageMarkup(player)}</div>
      <div class="detail-copy"><p class="eyebrow">${escapeHtml(player.category)} · ${escapeHtml(player.primary_position)}</p><h2>${escapeHtml(player.name_zh)}</h2><p>${escapeHtml(player.name_en)}</p>
        ${statsMarkup(player, "detail-stats")}
        <div class="radar-wrap">${radarMarkup(labels, values)}<div class="detail-meta"><span>综合评分 <b>${player.overall}</b></span><span>国籍 / 俱乐部 <b>${escapeHtml(player.nationality || "-")} / ${escapeHtml(player.club || "-")}</b></span><span>身高 / 体重 <b>${player.height_cm || "-"} cm / ${player.weight_kg || "-"} kg</b></span><span>花式 / 逆足 <b>${player.skill_moves}★ / ${player.weak_foot}★</b></span><span>副位置 <b>${escapeHtml(player.secondary_positions.join(" / ") || "无")}</b></span><div class="ability-row">${player.gold_abilities.map(item => `<span class="ability">◆ ${escapeHtml(item)}</span>`).join("")}${player.silver_abilities.map(item => `<span class="ability silver">◇ ${escapeHtml(item)}</span>`).join("")}</div></div></div>
      </div>
    </div>
    ${performanceMarkup(performance)}`;
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
      if (result) state.reviewAuctionId = result.id;
      if (result && state.lastSettlementId !== result.id) showSettlement(result);
      const profile = await api("me");
      state.user = profile.user;
      renderUserBar();
      await loadPlayers();
      if (state.page === "history") await loadAuctionHistory();
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
    const review = reviewAuctionRecord();
    if (review) {
      renderAuctionReview(review);
      return;
    }
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

function reviewAuctionRecord() {
  const records = [...(state.auction?.recent || []), ...state.auctionHistory];
  return records.find(item => item.id === state.reviewAuctionId) || state.auction?.recent?.[0] || null;
}

function renderAuctionReview(record) {
  const sold = record.status === "sold";
  const renderKey = `review:${record.id}:${record.bids?.length || 0}`;
  if (state.renderedAuctionKey !== renderKey) {
    $("#auction-player-card").className = "auction-player-card review-player-card";
    $("#auction-player-card").innerHTML = playerShowcaseMarkup(record.player);
    $("#auction-player-card").onclick = () => openPlayer(record.player.id);
    $("#auction-stage").className = `auction-stage review-stage ${record.auction_type === "sealed" ? "sealed-stage" : ""}`;
    $("#auction-stage").innerHTML = `
      <div class="auction-mode"><span class="active">${record.auction_type === "sealed" ? "暗拍" : "明拍"}</span><span>只读复盘</span></div>
      <div class="countdown-orbit review-orbit"><div><small>拍卖结果</small><strong>${sold ? "成交" : "流拍"}</strong><span>场次 #${record.id}</span></div></div>
      <div class="live-price"><small>${sold ? "最终成交价" : "本轮结果"}</small><strong>${sold ? money(record.final_price) : "无人成交"}</strong><span>${sold ? escapeHtml(record.winner_team_name) : "拍品未售出"}</span></div>
      <div class="review-summary"><span><small>起拍价</small><b>${money(record.start_price)}</b></span><span><small>报价球队</small><b>${record.bid_count || 0} 支</b></span><span><small>结束时间</small><b>${new Date(record.ends_at * 1000).toLocaleString("zh-CN")}</b></span></div>
      <p class="spectator-note">竞拍已经结束，球员信息、竞价席与全部报价保留供复盘查看。</p>`;
    state.renderedAuctionKey = renderKey;
  }
  renderBidSeats(record.bids || [], state.auction.teams || []);
  renderBidHistory(record.bids || []);
  $("#bid-count").textContent = `${record.bids?.length || 0} 条报价`;
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
  const roles = (player.roles || []).flatMap(role => String(role).split("、")).filter(Boolean).slice(0, 2);
  const abilityRow = (label, rating, abilities, tone) => `<div class="showcase-ability-row"><span>${label} <strong>${rating}★</strong></span><i class="${tone}"></i><div>${abilities.length ? abilities.map(value => `<b class="${tone}">${escapeHtml(value)}</b>`).join("") : `<small>暂无徽章</small>`}</div></div>`;
  return `<div class="showcase-upper">
      <div class="showcase-head"><div><strong>${player.overall}</strong><span>${escapeHtml(player.primary_position)}</span><small>${escapeHtml(player.nationality || "-")}</small></div><em>${escapeHtml(player.category)}</em></div>
      <div class="showcase-photo">${imageMarkup(player)}</div>
      <div class="showcase-role-lines">${roles.length ? roles.map((role, index) => `<span><b>角色${index === 0 ? "++" : "+"}</b>${escapeHtml(role)}</span>`).join("") : `<span><b>位置</b>${escapeHtml(player.primary_position)}</span>`}</div>
      <span class="showcase-physical">${player.height_cm || "-"} cm · ${player.weight_kg || "-"} kg</span>
    </div>
    <div class="showcase-lower">
      <div class="showcase-name"><small>${escapeHtml(player.name_en)}</small><h2>${escapeHtml(player.name_zh)}</h2></div>
      <div class="showcase-data">${radarMarkup(Object.keys(player.stats), Object.values(player.stats))}${statsMarkup(player, "showcase-stats")}</div>
      <div class="showcase-traits">${abilityRow("花式", player.skill_moves, player.gold_abilities || [], "gold")}${abilityRow("逆足", player.weak_foot, player.silver_abilities || [], "silver")}</div>
    </div>`;
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

function submitBid(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const amount = Number(new FormData(form).get("amount"));
  const active = state.auction?.active;
  if (!active || !Number.isInteger(amount) || amount < Number($("input[name=amount]", form).min)) {
    toast("请填写有效的整数报价", "error");
    return;
  }
  state.pendingBid = { amount, auctionId: active.id, auctionType: active.auction_type };
  $("#bid-confirm-copy").textContent = active.auction_type === "sealed" ? "暗拍每支球队只能提交一次，提交后不能修改，也不会重置倒计时。" : "报价提交成功后将进入竞价席，并把倒计时重新计满。";
  $("#bid-confirm-amount").textContent = money(amount);
  $("#bid-confirm-hint").textContent = `当前可用余额 ${money(state.user.funds)}`;
  $("#bid-confirm-dialog").showModal();
}

async function confirmBid() {
  const pending = state.pendingBid;
  if (!pending) return;
  const button = $("#bid-confirm-submit");
  button.disabled = true;
  try {
    await api("bid", { method: "POST", body: JSON.stringify({ amount: pending.amount, auction_id: pending.auctionId }) });
    $("#bid-confirm-dialog").close();
    toast(pending.auctionType === "sealed" ? "暗拍报价已密封提交" : `报价 ${money(pending.amount)} 已进入竞价席`);
    state.pendingBid = null;
    await refreshAuction();
    const input = $("#bid-form input[name=amount]");
    if (input && state.auction.active?.auction_type === "open") input.value = input.min;
  } catch (error) {
    $("#bid-confirm-dialog").close();
    state.pendingBid = null;
    await refreshAuction();
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function poolCard(item, active = false) {
  const player = item.player;
  const bidCount = item.auction_type === "sealed" ? item.bid_count : item.bids?.length;
  return `<div class="pool-card ${active ? "active-pool-card" : ""}">${imageMarkup(player)}<div><b>${escapeHtml(player.name_zh)}</b><small>${active ? `竞拍中 · ${bidCount || 0} ${item.auction_type === "sealed" ? "队已报价" : "次报价"}` : `${item.auction_type === "sealed" ? "暗拍" : "明拍"} · ${player.overall} · ${escapeHtml(player.primary_position)} · 起拍 ${money(item.start_price)}`}</small>${active && state.user.role === "admin" ? `<div class="pool-admin-actions"><button data-settle-auction type="button">落槌成交</button><button data-withdraw-auction type="button">撤回拍卖</button></div>` : ""}</div><span>${active ? "LIVE" : `#${item.id}`}</span></div>`;
}

function resultCard(item) {
  return `<button type="button" class="result-card" data-review-auction="${item.id}">${imageMarkup(item.player)}<div><b>${escapeHtml(item.player.name_zh)}</b><small>${item.auction_type === "sealed" ? "暗拍" : "明拍"} · ${item.status === "sold" ? escapeHtml(item.winner_team_name) : "流拍"}</small></div><span class="result-status">${item.status === "sold" ? money(item.final_price) : "UNSOLD"}</span></button>`;
}

function renderAuctionPool() {
  const { active, queued, recent } = state.auction;
  const collections = {
    queued: active ? [active, ...queued] : queued,
    sold: recent.filter(item => item.status === "sold"),
    unsold: recent.filter(item => item.status === "unsold"),
  };
  const items = collections[state.poolTab];
  $("#pool-count").textContent = `${items.length} 人`;
  $("#auction-pool").innerHTML = items.length
    ? items.map(item => state.poolTab === "queued" ? poolCard(item, item === active) : resultCard(item)).join("")
    : `<div class="empty-copy">${state.poolTab === "queued" ? "拍卖池还是空的" : "暂无记录"}</div>`;
  $$('[data-pool-tab]').forEach(button => button.classList.toggle("active", button.dataset.poolTab === state.poolTab));
  $("[data-settle-auction]", $("#auction-pool"))?.addEventListener("click", settleAuction);
  $("[data-withdraw-auction]", $("#auction-pool"))?.addEventListener("click", withdrawAuction);
  $$("[data-review-auction]", $("#auction-pool")).forEach(button => button.onclick = () => openAuctionReview(Number(button.dataset.reviewAuction)));
}

async function loadAuctionHistory() {
  try {
    const payload = await api("auction/history");
    state.auctionHistory = payload.auctions;
    renderAuctionHistory();
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderAuctionHistory() {
  const type = $("#history-type-filter").value;
  const status = $("#history-status-filter").value;
  const records = state.auctionHistory.filter(item => (!type || item.auction_type === type) && (!status || item.status === status));
  const soldCount = state.auctionHistory.filter(item => item.status === "sold").length;
  const sealedCount = state.auctionHistory.filter(item => item.auction_type === "sealed").length;
  $("#history-summary").innerHTML = `<span><small>全部场次</small><b>${state.auctionHistory.length}</b></span><span><small>成交</small><b>${soldCount}</b></span><span><small>暗拍</small><b>${sealedCount}</b></span>`;
  $("#auction-history-list").innerHTML = records.length ? records.map(historyRecordMarkup).join("") : `<div class="empty-copy history-empty">暂无符合条件的拍卖纪录</div>`;
  $$("[data-history-review]", $("#auction-history-list")).forEach(button => button.onclick = () => openAuctionReview(Number(button.dataset.historyReview)));
  $$("[data-history-player]", $("#auction-history-list")).forEach(button => button.onclick = () => openPlayer(button.dataset.historyPlayer));
}

function historyRecordMarkup(record) {
  const sold = record.status === "sold";
  const bids = record.bids || [];
  return `<article class="auction-history-card">
    <button type="button" class="history-player" data-history-player="${record.player.id}">${imageMarkup(record.player)}<span><small>#${record.id} · ${record.auction_type === "sealed" ? "暗拍" : "明拍"} · ${record.player.primary_position}</small><b>${escapeHtml(record.player.name_zh)}</b><em>${escapeHtml(record.player.nationality || "-")} · ${escapeHtml(record.player.club || "-")}</em></span><strong>${record.player.overall}</strong></button>
    <div class="history-result ${sold ? "sold" : "unsold"}"><small>${sold ? "成交价" : "拍卖结果"}</small><b>${sold ? money(record.final_price) : "流拍"}</b><span>${sold ? escapeHtml(record.winner_team_name) : "无人中标"}</span></div>
    <div class="history-meta"><span>起拍 ${money(record.start_price)}</span><span>${record.bid_count || 0} 支球队</span><span>${bids.length} 条报价</span><span>${new Date(record.ends_at * 1000).toLocaleString("zh-CN")}</span></div>
    <details class="history-bid-details"><summary>查看全部报价</summary><div>${bids.length ? bids.map((bid, index) => `<p><span>${String(index + 1).padStart(2, "0")} · ${escapeHtml(bid.team_name)}</span><small>${new Date(bid.created_at * 1000).toLocaleTimeString("zh-CN")}</small><b>${money(bid.amount)}</b></p>`).join("") : `<span class="empty-copy">本场没有有效报价</span>`}</div></details>
    <button type="button" class="secondary-button history-review-button" data-history-review="${record.id}">进入竞拍页复盘</button>
  </article>`;
}

function openAuctionReview(auctionId) {
  state.reviewAuctionId = auctionId;
  state.renderedAuctionKey = null;
  navigate("market");
  renderAuction();
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
  const items = sortedRosterItems(state.roster.roster, state.rosterSort);
  const groups = new Map();
  items.forEach(item => {
    const label = state.rosterGroup === "nationality" ? (item.player.nationality || "未知国籍") : state.rosterGroup === "position" ? item.player.primary_position : "全部球员";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  });
  $("#roster-list").innerHTML = items.length ? [...groups].map(([label, players]) => `<section class="roster-group"><header><h2>${escapeHtml(label)}</h2><span>${players.length} 人</span></header><div class="roster-cards">${players.map(rosterCardMarkup).join("")}</div></section>`).join("") : `<div class="empty-copy roster-empty">成交球员会出现在这里</div>`;
  $$("[data-player-id]", $("#roster-list")).forEach(element => element.onclick = () => openPlayer(element.dataset.playerId));
}

function sortedRosterItems(roster, sort = "position-price") {
  const positionOrder = ["GK", "CB", "LB", "RB", "CDM", "CM", "CAM", "LM", "RM", "LW", "RW", "ST"];
  return [...roster].sort((left, right) => {
    if (sort === "price-desc") return right.acquired_price - left.acquired_price;
    if (sort === "price-asc") return left.acquired_price - right.acquired_price;
    if (sort === "nationality") return String(left.player.nationality).localeCompare(String(right.player.nationality), "zh-CN") || right.acquired_price - left.acquired_price;
    return positionOrder.indexOf(left.player.primary_position) - positionOrder.indexOf(right.player.primary_position) || right.acquired_price - left.acquired_price;
  });
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

async function loadMatches(preserveEditor = false) {
  try {
    state.matchData = await api("matches");
    renderMatchResults();
    if (state.user?.role === "admin" && (!preserveEditor || !state.editingMatchId)) renderMatchEditor();
  } catch (error) {
    if (error.status === 401) return bootstrap();
    toast(error.message, "error");
  }
}

function matchTeamOptions(selectedId) {
  return state.matchData.teams.map(team => `<option value="${team.id}" ${Number(selectedId) === Number(team.id) ? "selected" : ""}>${escapeHtml(team.name)}</option>`).join("");
}

function localDateTimeValue(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function updateMatchStageFields() {
  const knockout = $("#match-stage").value === "knockout";
  $("#match-group-field").hidden = knockout;
  $("#match-penalty-field").hidden = !knockout;
  if (!knockout) {
    $("#match-home-penalties").value = "";
    $("#match-away-penalties").value = "";
  }
}

function renderMatchEditor() {
  const match = state.matchData.matches.find(item => item.id === state.editingMatchId);
  const teams = state.matchData.teams;
  $("#match-editor-title").textContent = match ? `编辑比赛 #${match.id}` : "录入赛程 / 赛果";
  $("#match-id").value = match?.id || 0;
  $("#match-stage").value = match?.stage || "group";
  $("#match-group-name").value = match?.group_name || "A组";
  $("#match-round-name").value = match?.round_name || "小组赛";
  $("#match-home-team").innerHTML = teams.length ? matchTeamOptions(match?.home_team_id || teams[0].id) : `<option value="">暂无球队</option>`;
  $("#match-away-team").innerHTML = teams.length ? matchTeamOptions(match?.away_team_id || teams[1]?.id || teams[0].id) : `<option value="">暂无球队</option>`;
  $("#match-played-at").value = localDateTimeValue(match?.played_at);
  $("#match-home-score").value = match?.home_score ?? "";
  $("#match-away-score").value = match?.away_score ?? "";
  $("#match-home-penalties").value = match?.home_penalties ?? "";
  $("#match-away-penalties").value = match?.away_penalties ?? "";
  $("#match-cancel-edit").hidden = !match;
  $("#match-form button[type=submit]").disabled = teams.length < 2;
  updateMatchStageFields();
}

function standingsMarkup(group) {
  return `<article class="standings-card"><header><h3>${escapeHtml(group.group_name)}</h3><span>${group.rows.length} 支球队</span></header><div class="standings-table"><div class="standings-row standings-head"><span>#</span><span>球队</span><span>赛</span><span>胜 / 平 / 负</span><span>进 / 失</span><span>净胜</span><b>积分</b></div>${group.rows.map(row => `<div class="standings-row"><span class="standings-rank">${row.rank}</span><span class="standings-team">${teamAvatar(row.team_name, row.team_id || row.team_name)}<b>${escapeHtml(row.team_name)}</b></span><span>${row.played}</span><span>${row.wins} / ${row.draws} / ${row.losses}</span><span>${row.goals_for} / ${row.goals_against}</span><span class="${row.goal_difference > 0 ? "positive" : row.goal_difference < 0 ? "negative" : ""}">${row.goal_difference > 0 ? "+" : ""}${row.goal_difference}</span><b>${row.points}</b></div>`).join("")}</div></article>`;
}

function playerLeaderMarkup(items, metric) {
  return items.length ? items.slice(0, 10).map((item, index) => `<button type="button" class="player-leader-row" data-player-id="${item.player_id}"><span>${index + 1}</span>${imageMarkup(item.player)}<div><b>${escapeHtml(item.player_name)}</b><small>${escapeHtml(item.team_name)} · ${item.appearances} 场记录</small></div><strong>${metric === "goals" ? "⚽" : "助"} ${item[metric]}</strong></button>`).join("") : `<div class="empty-copy player-leader-empty">暂无记录</div>`;
}

function renderPlayerLeaders() {
  const leaders = state.matchData.leaders || { scorers: [], assists: [] };
  $("#scorer-leaders").innerHTML = playerLeaderMarkup(leaders.scorers, "goals");
  $("#assist-leaders").innerHTML = playerLeaderMarkup(leaders.assists, "assists");
  $$('[data-player-id]', $(".player-leaderboard-panel")).forEach(button => button.onclick = () => openPlayer(button.dataset.playerId));
}

function matchWinnerSide(match) {
  if (match.home_score === null || match.away_score === null || match.stage !== "knockout") return null;
  if (match.home_score !== match.away_score) return match.home_score > match.away_score ? "home" : "away";
  return match.home_penalties > match.away_penalties ? "home" : "away";
}

function matchCardMarkup(match) {
  const completed = match.home_score !== null && match.away_score !== null;
  const winnerSide = matchWinnerSide(match);
  const penalties = match.home_penalties !== null ? `<small>点球 ${match.home_penalties} : ${match.away_penalties}</small>` : "";
  const score = completed ? `<strong>${match.home_score}<i>:</i>${match.away_score}</strong>${penalties}` : `<strong class="pending-score">待赛</strong>`;
  const playerStats = match.player_stats?.length ? `<div class="match-player-stats">${match.player_stats.map(stat => `<button type="button" data-player-id="${stat.player_id}">${imageMarkup(stat.player)}<span><b>${escapeHtml(stat.player_name)}</b><small>${escapeHtml(stat.team_name)}</small></span>${stat.goals ? `<em>⚽ ${stat.goals}</em>` : ""}${stat.assists ? `<em class="assist-stat">助 ${stat.assists}</em>` : ""}</button>`).join("")}</div>` : "";
  const actions = state.user?.role === "admin" ? `<div class="match-card-actions">${completed ? `<button class="match-stat-action" data-match-stats="${match.id}">进球 / 助攻${match.player_stats?.length ? `（${match.player_stats.length} 人）` : ""}</button>` : ""}<button data-edit-match="${match.id}">编辑</button><button class="danger-action" data-delete-match="${match.id}">删除</button></div>` : "";
  return `<article class="match-card ${completed ? "completed" : "scheduled"}"><header><span>${escapeHtml(match.stage === "group" ? `${match.group_name} · ${match.round_name}` : match.round_name)}</span><time>${match.played_at ? new Date(match.played_at * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "时间待定"}</time></header><div class="match-versus"><div class="${winnerSide === "home" ? "winner" : ""}">${teamAvatar(match.home_team_name, match.home_team_id || match.home_team_name)}<b>${escapeHtml(match.home_team_name)}</b>${winnerSide === "home" ? `<em>晋级</em>` : ""}</div><div class="match-score">${score}</div><div class="${winnerSide === "away" ? "winner" : ""}">${teamAvatar(match.away_team_name, match.away_team_id || match.away_team_name)}<b>${escapeHtml(match.away_team_name)}</b>${winnerSide === "away" ? `<em>晋级</em>` : ""}</div></div>${playerStats}${actions}</article>`;
}

function renderMatchResults() {
  renderPlayerLeaders();
  $("#standings-grid").innerHTML = state.matchData.standings.length ? state.matchData.standings.map(standingsMarkup).join("") : `<div class="empty-copy match-empty">录入小组赛后自动生成积分榜</div>`;
  const groupMatches = state.matchData.matches.filter(match => match.stage === "group");
  const knockoutMatches = state.matchData.matches.filter(match => match.stage === "knockout");
  const sections = [];
  if (groupMatches.length) sections.push(`<section class="match-stage-section"><header><h3>小组赛</h3><span>${groupMatches.length} 场</span></header><div>${groupMatches.map(matchCardMarkup).join("")}</div></section>`);
  if (knockoutMatches.length) sections.push(`<section class="match-stage-section knockout"><header><h3>淘汰赛</h3><span>${knockoutMatches.length} 场</span></header><div>${knockoutMatches.map(matchCardMarkup).join("")}</div></section>`);
  $("#match-results").innerHTML = sections.join("") || `<div class="empty-copy match-empty">管理员录入比赛后会显示在这里</div>`;
  $("#match-count").textContent = `${state.matchData.matches.length} 场`;
  $$('[data-edit-match]').forEach(button => button.onclick = () => {
    state.editingMatchId = Number(button.dataset.editMatch);
    renderMatchEditor();
    $("#match-editor-title").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $$('[data-delete-match]').forEach(button => button.onclick = () => deleteMatch(Number(button.dataset.deleteMatch)));
  $$('[data-match-stats]').forEach(button => button.onclick = () => openMatchStats(Number(button.dataset.matchStats)));
  $$('[data-player-id]', $("#match-results")).forEach(button => button.onclick = () => openPlayer(button.dataset.playerId));
}

function openMatchStats(matchId) {
  const match = state.matchData.matches.find(item => item.id === matchId);
  if (!match || match.home_score === null) return;
  state.matchStatMatchId = matchId;
  state.matchStatSideTeamId = match.home_team_id;
  state.matchStatDraft = match.player_stats.map(stat => ({
    player_id: stat.player_id,
    team_id: stat.team_id,
    goals: stat.goals,
    assists: stat.assists,
  }));
  $("#match-stat-search").value = "";
  renderMatchStatDialog();
  $("#match-stat-dialog").showModal();
}

function renderMatchStatDialog() {
  const match = state.matchData.matches.find(item => item.id === state.matchStatMatchId);
  if (!match) return;
  $("#match-stat-title").textContent = `${match.home_team_name} vs ${match.away_team_name}`;
  $("#match-stat-score").textContent = `${match.home_score} : ${match.away_score} · ${match.stage === "group" ? match.group_name : match.round_name}`;
  $("#match-stat-team").innerHTML = `<option value="${match.home_team_id}" ${state.matchStatSideTeamId === match.home_team_id ? "selected" : ""}>${escapeHtml(match.home_team_name)}</option><option value="${match.away_team_id}" ${state.matchStatSideTeamId === match.away_team_id ? "selected" : ""}>${escapeHtml(match.away_team_name)}</option>`;
  renderMatchStatCandidates();
  renderMatchStatRows();
}

function renderMatchStatCandidates() {
  const match = state.matchData.matches.find(item => item.id === state.matchStatMatchId);
  if (!match) return;
  const query = $("#match-stat-search").value.trim().toLowerCase();
  const sideName = state.matchStatSideTeamId === match.home_team_id ? match.home_team_name : match.away_team_name;
  const selected = new Set(state.matchStatDraft.map(item => String(item.player_id)));
  const players = state.players
    .filter(player => !selected.has(String(player.id)) && `${player.name_zh} ${player.name_en} ${player.club} ${player.nationality}`.toLowerCase().includes(query))
    .sort((a, b) => Number(b.team_name === sideName) - Number(a.team_name === sideName) || b.overall - a.overall)
    .slice(0, 18);
  $("#match-stat-candidates").innerHTML = players.length ? players.map(player => `<button type="button" data-add-match-player="${player.id}">${imageMarkup(player)}<span><b>${escapeHtml(player.name_zh)}</b><small>${escapeHtml(player.team_name || "当前未归属")} · ${player.overall} · ${escapeHtml(player.primary_position)}</small></span><i>＋ 添加</i></button>`).join("") : `<div class="empty-copy">没有匹配的可添加球员</div>`;
  $$('[data-add-match-player]').forEach(button => button.onclick = () => {
    state.matchStatDraft.push({ player_id: button.dataset.addMatchPlayer, team_id: state.matchStatSideTeamId, goals: 1, assists: 0 });
    renderMatchStatCandidates();
    renderMatchStatRows();
  });
}

function renderMatchStatRows() {
  const match = state.matchData.matches.find(item => item.id === state.matchStatMatchId);
  $("#match-stat-rows").innerHTML = state.matchStatDraft.length ? state.matchStatDraft.map((stat, index) => {
    const player = state.players.find(item => String(item.id) === String(stat.player_id));
    const teamName = stat.team_id === match.home_team_id ? match.home_team_name : match.away_team_name;
    return `<div class="match-stat-row" data-match-stat-index="${index}">${imageMarkup(player)}<div><b>${escapeHtml(player.name_zh)}</b><small>${escapeHtml(teamName)}</small></div><label>进球<input data-stat-goals type="number" min="0" max="99" value="${stat.goals}"></label><label>助攻<input data-stat-assists type="number" min="0" max="99" value="${stat.assists}"></label><button type="button" data-remove-match-stat="${index}">移除</button></div>`;
  }).join("") : `<div class="empty-copy match-stat-empty">尚未添加球员，可以分次向前补录</div>`;
  $$('[data-remove-match-stat]').forEach(button => button.onclick = () => {
    state.matchStatDraft.splice(Number(button.dataset.removeMatchStat), 1);
    renderMatchStatCandidates();
    renderMatchStatRows();
  });
}

async function saveMatchStats() {
  const stats = $$("[data-match-stat-index]").map(row => ({
    ...state.matchStatDraft[Number(row.dataset.matchStatIndex)],
    goals: Number($("[data-stat-goals]", row).value || 0),
    assists: Number($("[data-stat-assists]", row).value || 0),
  }));
  try {
    await api("admin/match/stats/save", { method: "POST", body: JSON.stringify({ match_id: state.matchStatMatchId, stats }) });
    toast("球员进球助攻记录已保存");
    $("#match-stat-dialog").close();
    state.matchStatMatchId = null;
    await loadMatches();
  } catch (error) { toast(error.message, "error"); }
}

async function saveMatch(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  ["match_id", "home_team_id", "away_team_id"].forEach(key => data[key] = Number(data[key]));
  data.played_at = data.played_at ? Math.floor(new Date(data.played_at).getTime() / 1000) : null;
  try {
    await api("admin/match/save", { method: "POST", body: JSON.stringify(data) });
    toast(state.editingMatchId ? "赛果已更新，积分榜已重新计算" : "比赛已保存");
    state.editingMatchId = null;
    await loadMatches();
  } catch (error) { toast(error.message, "error"); }
}

async function deleteMatch(matchId) {
  const match = state.matchData.matches.find(item => item.id === matchId);
  if (!match || !window.confirm(`确认删除 ${match.home_team_name} 对 ${match.away_team_name} 的比赛？积分榜会立即重新计算。`)) return;
  try {
    await api("admin/match/delete", { method: "POST", body: JSON.stringify({ match_id: matchId }) });
    if (state.editingMatchId === matchId) state.editingMatchId = null;
    toast("比赛已删除，积分榜已更新");
    await loadMatches();
  } catch (error) { toast(error.message, "error"); }
}

async function loadTradeCenter() {
  if (state.user?.role !== "participant") return;
  try {
    const [options, trades] = await Promise.all([api("trade/options"), api("trades")]);
    state.tradeOptions = options.teams;
    state.trades = trades.trades;
    renderTradeBuilder();
    renderTrades();
  } catch (error) { toast(error.message, "error"); }
}

async function refreshTrades() {
  try {
    const previousStatuses = new Map(state.trades.map(trade => [trade.id, trade.status]));
    state.trades = (await api("trades")).trades;
    const completedNow = state.trades.some(trade => trade.status === "completed" && previousStatuses.get(trade.id) === "pending");
    if (completedNow) {
      const [profile, options] = await Promise.all([api("me"), api("trade/options"), loadPlayers()]);
      state.user = profile.user;
      state.tradeOptions = options.teams;
      renderUserBar();
      renderTradeBuilder();
    }
    renderTrades();
  } catch (error) {
    if (error.status === 401) return bootstrap();
  }
}

function tradeTeam(teamId) {
  return state.tradeOptions.find(team => Number(team.id) === Number(teamId));
}

function tradeTeamOrder() {
  return [Number(state.user.team_id), ...state.tradeSelectedTeamIds.slice(0, state.tradePartyCount - 1)];
}

function renderTradeBuilder() {
  const ownTeamId = Number(state.user.team_id);
  const opponents = state.tradeOptions.filter(team => Number(team.id) !== ownTeamId);
  const required = state.tradePartyCount - 1;
  state.tradeSelectedTeamIds = state.tradeSelectedTeamIds
    .map(Number)
    .filter((teamId, index, values) => teamId !== ownTeamId && opponents.some(team => team.id === teamId) && values.indexOf(teamId) === index)
    .slice(0, required);
  for (const team of opponents) {
    if (state.tradeSelectedTeamIds.length >= required) break;
    if (!state.tradeSelectedTeamIds.includes(team.id)) state.tradeSelectedTeamIds.push(team.id);
  }
  $$('[data-trade-parties]').forEach(button => button.classList.toggle("active", Number(button.dataset.tradeParties) === state.tradePartyCount));
  const enoughTeams = state.tradeSelectedTeamIds.length === required;
  const selectors = [`<div class="trade-team-fixed"><small>发起球队</small>${teamAvatar(state.user.team_name, ownTeamId)}<b>${escapeHtml(state.user.team_name)}</b></div>`];
  for (let index = 0; index < required; index += 1) {
    const selected = state.tradeSelectedTeamIds[index];
    const usedByOthers = new Set(state.tradeSelectedTeamIds.filter((_, otherIndex) => otherIndex !== index));
    selectors.push(`<label><small>${state.tradePartyCount === 2 ? "交易对方" : `参与球队 ${index + 2}`}</small><select data-trade-team-index="${index}">${opponents.filter(team => !usedByOthers.has(team.id)).map(team => `<option value="${team.id}" ${team.id === selected ? "selected" : ""}>${escapeHtml(team.name)} · ${team.roster.length} 人 · ${money(team.funds)}</option>`).join("")}</select></label>`);
  }
  $("#trade-team-selectors").innerHTML = enoughTeams ? selectors.join("") : `<div class="empty-copy">当前没有足够的有效参与球队发起 ${state.tradePartyCount} 方交易</div>`;
  $$('[data-trade-team-index]').forEach(select => select.onchange = () => {
    state.tradeSelectedTeamIds[Number(select.dataset.tradeTeamIndex)] = Number(select.value);
    renderTradeBuilder();
  });
  const order = enoughTeams ? tradeTeamOrder() : [];
  $("#trade-cycle-summary").innerHTML = order.length ? order.map((teamId, index) => {
    const team = tradeTeam(teamId);
    const target = tradeTeam(order[(index + 1) % order.length]);
    return `<span>${escapeHtml(team.name)} <b>→</b> ${escapeHtml(target.name)}</span>`;
  }).join("") : "";
  $("#trade-leg-editor").innerHTML = order.map((teamId, index) => tradeLegEditorMarkup(tradeTeam(teamId), tradeTeam(order[(index + 1) % order.length]))).join("");
  $("#submit-trade").disabled = !enoughTeams;
}

function tradeLegEditorMarkup(team, target) {
  const roster = team.roster || [];
  return `<article class="trade-leg-card" data-trade-leg-from="${team.id}" data-trade-leg-to="${target.id}">
    <header><div>${teamAvatar(team.name, team.id)}<span><small>转出方</small><b>${escapeHtml(team.name)}</b></span></div><em>→</em><div>${teamAvatar(target.name, target.id)}<span><small>接收方</small><b>${escapeHtml(target.name)}</b></span></div></header>
    <label class="trade-cash-field"><span>附加现金</span><div><input data-trade-cash type="number" min="0" step="1" value="0"><small>万</small></div><em>当前余额 ${money(team.funds)}</em></label>
    <div class="trade-player-picker"><strong>选择 ${escapeHtml(team.name)} 转出的球员</strong><div>${roster.length ? roster.map(item => `<label class="trade-player-option"><input type="checkbox" data-trade-player="${item.player_id}">${imageMarkup(item.player)}<span><b>${escapeHtml(item.player.name_zh)}</b><small>${item.player.overall} · ${escapeHtml(item.player.primary_position)} · 原成交 ${money(item.acquired_price)}</small></span><i>选择</i></label>`).join("") : `<p class="empty-copy">该球队暂无可交易球员，可仅配置现金</p>`}</div></div>
  </article>`;
}

async function submitTrade() {
  const legs = $$("[data-trade-leg-from]").map(card => ({
    from_team_id: Number(card.dataset.tradeLegFrom),
    to_team_id: Number(card.dataset.tradeLegTo),
    cash_amount: Number($("[data-trade-cash]", card).value || 0),
    player_ids: $$('[data-trade-player]:checked', card).map(input => input.dataset.tradePlayer),
  }));
  if (legs.some(leg => !Number.isInteger(leg.cash_amount) || leg.cash_amount < 0)) return toast("交易现金必须是非负整数", "error");
  if (!legs.some(leg => leg.cash_amount > 0 || leg.player_ids.length)) return toast("请至少选择一名球员或填写一笔现金", "error");
  const teamNames = tradeTeamOrder().map(teamId => tradeTeam(teamId)?.name).filter(Boolean).join("、");
  if (!window.confirm(`确认向 ${teamNames} 发起这笔交易？提交后需要其他参与球队全部同意。`)) return;
  try {
    await api("trade/create", { method: "POST", body: JSON.stringify({ legs }) });
    toast("交易申请已发出");
    await loadTradeCenter();
  } catch (error) { toast(error.message, "error"); }
}

function tradeStatusLabel(status) {
  return ({ pending: "等待确认", completed: "交易完成", rejected: "已拒绝", cancelled: "已撤回", invalid: "已失效" })[status] || status;
}

function renderTrades() {
  if (!$("#trade-list")) return;
  const pending = state.trades.filter(trade => trade.status === "pending");
  $("#trade-pending-count").textContent = `${pending.length} 笔待处理`;
  $("#trade-list").innerHTML = state.trades.length ? state.trades.map(tradeMarkup).join("") : `<div class="empty-copy trade-empty">还没有交易申请</div>`;
  $$('[data-trade-response]').forEach(button => button.onclick = () => respondTrade(Number(button.dataset.tradeResponse), button.dataset.decision));
  $$('[data-trade-cancel]').forEach(button => button.onclick = () => cancelTrade(Number(button.dataset.tradeCancel)));
  $$('[data-trade-player-detail]').forEach(button => button.onclick = () => openPlayer(button.dataset.tradePlayerDetail));
}

function tradeMarkup(trade) {
  const myTeamId = Number(state.user.team_id);
  const myParticipant = trade.participants.find(participant => participant.team_id === myTeamId);
  const canRespond = trade.status === "pending" && myParticipant?.response === "pending";
  const canCancel = trade.status === "pending" && trade.creator_team_id === myTeamId;
  const participantMarkup = trade.participants.map(participant => `<span class="trade-response ${participant.response}">${teamAvatar(participant.team_name, participant.team_id)}<b>${escapeHtml(participant.team_name)}</b><small>${participant.response === "accepted" ? "已同意" : participant.response === "rejected" ? "已拒绝" : "待确认"}</small></span>`).join("");
  const legs = trade.legs.map(leg => `<div class="trade-leg-summary"><header><b>${escapeHtml(leg.from_team_name)}</b><span>→</span><b>${escapeHtml(leg.to_team_name)}</b></header><div>${leg.players.map(item => `<button type="button" data-trade-player-detail="${item.player_id}">${imageMarkup(item.player)}<span>${escapeHtml(item.player.name_zh)}<small>${item.player.overall} · ${escapeHtml(item.player.primary_position)}</small></span></button>`).join("") || `<em>无球员</em>`}${leg.cash_amount ? `<strong>＋ ${money(leg.cash_amount)}</strong>` : ""}</div></div>`).join("");
  const actions = canRespond ? `<button class="trade-reject" data-trade-response="${trade.id}" data-decision="rejected">拒绝</button><button class="trade-accept" data-trade-response="${trade.id}" data-decision="accepted">同意交易</button>` : canCancel ? `<button class="trade-reject" data-trade-cancel="${trade.id}">撤回申请</button>` : "";
  return `<article class="trade-record ${trade.status}"><header><div><span class="trade-status">${tradeStatusLabel(trade.status)}</span><h3>交易申请 #${trade.id}</h3><small>${new Date(trade.created_at * 1000).toLocaleString("zh-CN")} · ${trade.participants.length} 方交易</small></div><div class="trade-responses">${participantMarkup}</div></header><div class="trade-leg-summaries">${legs}</div>${actions ? `<footer>${actions}</footer>` : ""}</article>`;
}

async function respondTrade(tradeId, decision) {
  if (!window.confirm(decision === "accepted" ? "确认同意这笔交易？若你是最后一名确认者，交易会立即执行。" : "确认拒绝这笔交易？整笔交易将结束。")) return;
  try {
    const result = await api("trade/respond", { method: "POST", body: JSON.stringify({ trade_id: tradeId, decision }) });
    toast(result.trade.status === "completed" ? "交易已完成，球员和资金已更新" : decision === "accepted" ? "已同意，等待其他球队确认" : "已拒绝交易");
    state.user = (await api("me")).user;
    renderUserBar();
    await Promise.all([loadPlayers(), refreshAuction(), loadTradeCenter()]);
  } catch (error) { toast(error.message, "error"); }
}

async function cancelTrade(tradeId) {
  if (!window.confirm("确认撤回这笔交易申请？")) return;
  try {
    await api("trade/cancel", { method: "POST", body: JSON.stringify({ trade_id: tradeId }) });
    toast("交易申请已撤回");
    await loadTradeCenter();
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
  $("#draw-player").disabled = state.drawingPlayer || randomCandidates().length === 0;
}

function selectQueuePlayer(playerId, updatePreview = true) {
  const player = availableQueuePlayers().find(item => String(item.id) === String(playerId));
  if (!player) return;
  if (updatePreview && state.drawingPlayer) {
    state.drawRevealToken += 1;
    state.drawingPlayer = false;
  }
  state.queueSelection = player;
  $("#queue-player").value = player.id;
  $("#queue-submit").disabled = false;
  $("#queue-submit").textContent = state.queueStartImmediately ? `上架 ${player.name_zh} 并立即开拍` : `将 ${player.name_zh} 加入拍卖池`;
  if (updatePreview) $("#random-preview").innerHTML = `<div class="random-player-reveal">${imageMarkup(player)}<span><small>${escapeHtml(player.category)} · ${escapeHtml(player.primary_position)}</small><strong>${escapeHtml(player.name_zh)}</strong><em>${player.overall}</em></span></div>`;
  renderQueueSearch();
  renderRandomOptions();
}

function secureRandomIndex(length) {
  const range = 0x100000000;
  const ceiling = Math.floor(range / length) * length;
  const bucket = new Uint32Array(1);
  do { crypto.getRandomValues(bucket); } while (bucket[0] >= ceiling);
  return bucket[0] % length;
}

function randomRevealMarkup(player, step) {
  const clues = [
    ["国籍", player.nationality || "未知国籍"],
    ["位置", player.primary_position || "未知位置"],
    ["球队", player.club || "未知球队"],
  ];
  const clueMarkup = clues.map(([label, value], index) => {
    const revealed = index < step;
    const current = index === step - 1;
    return `<div class="random-clue ${revealed ? "revealed" : ""} ${current ? "current" : ""}"><small>${label}</small><strong>${revealed ? escapeHtml(value) : "•••"}</strong></div>`;
  }).join("");
  const final = step >= 4 ? `<div class="random-final-player">${imageMarkup(player)}<span><small>${escapeHtml(player.category)}</small><strong>${escapeHtml(player.name_zh)}</strong><em>${player.overall}</em></span></div>` : `<div class="random-final-lock"><span>FINAL REVEAL</span><b>球员即将揭晓</b></div>`;
  return `<div class="random-reveal-shell"><div class="random-reveal-title"><i></i><span>${step >= 4 ? "拍品揭晓" : "正在逐步揭晓"}</span><i></i></div><div class="random-clue-track">${clueMarkup}</div>${final}</div>`;
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function drawRandomPlayer() {
  const candidates = randomCandidates();
  if (!candidates.length) return toast("当前条件下没有可上架球员", "error");
  const player = candidates[secureRandomIndex(candidates.length)];
  const token = ++state.drawRevealToken;
  state.drawingPlayer = true;
  state.queueSelection = null;
  $("#queue-player").value = "";
  $("#queue-submit").disabled = true;
  $("#draw-player").textContent = "正在揭晓…";
  renderRandomOptions();
  for (let step = 1; step <= 4; step += 1) {
    if (token !== state.drawRevealToken) return;
    $("#random-preview").innerHTML = randomRevealMarkup(player, step);
    await wait(step === 4 ? 250 : 680);
  }
  if (token !== state.drawRevealToken) return;
  state.drawingPlayer = false;
  selectQueuePlayer(player.id, false);
  $("#draw-player").textContent = "再抽一名";
  renderRandomOptions();
}

function openQueueDialog(startImmediately = false) {
  state.drawRevealToken += 1;
  state.drawingPlayer = false;
  state.queueStartImmediately = Boolean(startImmediately);
  state.queueSelection = null;
  $("#queue-player").value = "";
  $("#queue-submit").disabled = true;
  $("#queue-dialog-title").textContent = state.queueStartImmediately ? "上架并立即开拍" : "拍品上架";
  $("#queue-dialog-copy").textContent = state.queueStartImmediately ? "选定球员和规则后立即开启竞价" : "选择指定球员，或按条件随机抽卡";
  $("#queue-submit").textContent = state.queueStartImmediately ? "选择球员后立即开拍" : "加入拍卖池";
  $("#random-preview").innerHTML = `<span>点击下方按钮抽取一名球员</span>`;
  $("#draw-player").textContent = "随机抽取一名";
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
  return `<div class="admin-team-row"><div class="admin-team-identity">${teamAvatar(team.name, team.id)}<span><b>${escapeHtml(team.name)}</b><small>${team.username ? `账号：${escapeHtml(team.username)}` : "账号已释放"} · ${team.roster_count} 名球员</small></span></div>${editing ? `<input class="funds-editor" type="number" min="0" value="${team.funds}" data-funds-team="${team.id}">` : `<div class="funds-readout"><small>当前资金</small><strong>${money(team.funds)}</strong></div>`}<div class="admin-team-actions">${editing ? `<button data-save-funds="${team.id}">保存资金</button><button class="secondary-action" data-cancel-funds="${team.id}">取消</button>` : `<button data-edit-funds="${team.id}">编辑资金</button>`}<button class="manage-roster-action" data-view-roster="${team.id}">管理 / 释放球员（${team.roster_count}）</button>${team.participant_user_id ? `<button class="danger-action" data-release-participant="${team.id}" data-roster-count="${team.roster_count}" data-roster-value="${team.roster_value}">释放账号及全部球员</button>` : ""}</div></div>`;
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
  const groups = new Map();
  sortedRosterItems(roster).forEach(item => {
    const position = item.player.primary_position || "其他";
    if (!groups.has(position)) groups.set(position, []);
    groups.get(position).push(item);
  });
  $("#admin-roster-detail").innerHTML = `
    <header class="admin-roster-header">
      <div><p class="eyebrow">TEAM SQUAD · ADMIN</p><h2>${escapeHtml(team.name)}</h2><span>点击球员卡查看详情；点击红色按钮释放单个球员并返还成交金额</span></div>
      <div class="admin-roster-summary"><span><small>剩余资金</small><b>${money(team.funds)}</b></span><span><small>球员</small><b>${roster.length}</b></span><span><small>首发 / 替补</small><b>${starters.length} / ${bench.length}</b></span></div>
    </header>
    <div class="admin-roster-list">${roster.length ? [...groups].map(([position, items]) => `<section class="roster-group"><header><h2>${escapeHtml(position)}</h2><span>${items.length} 人</span></header><div class="roster-cards">${items.map(item => `<div class="admin-roster-entry">${rosterCardMarkup(item)}<button type="button" class="release-player-button" data-release-player="${item.player.id}" data-team-id="${team.id}"><span>释放此球员</span><strong>返还 ${money(item.acquired_price)}</strong></button></div>`).join("")}</div></section>`).join("") : `<div class="empty-copy roster-empty">该球队暂无球员</div>`}</div>`;
  $$('[data-player-id]', $("#admin-roster-detail")).forEach(element => element.onclick = () => openPlayer(element.dataset.playerId));
  $$('[data-release-player]', $("#admin-roster-detail")).forEach(button => button.onclick = () => releasePlayer(Number(button.dataset.teamId), button.dataset.releasePlayer));
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
  const button = $(`[data-release-participant="${teamId}"]`);
  const teamName = $(".admin-team-identity b", row)?.textContent || `球队 #${teamId}`;
  const playerCount = Number(button?.dataset.rosterCount || 0);
  const refund = Number(button?.dataset.rosterValue || 0);
  if (!window.confirm(`确认彻底删除“${teamName}”的参与者账号，并释放全部 ${playerCount} 名球员？账号、会话及报价记录会被删除，球员退回球员库，并返还 ${money(refund)}。此操作不可撤销。`)) return;
  try {
    const result = await api("admin/participant/release", { method: "POST", body: JSON.stringify({ team_id: Number(teamId) }) });
    toast(`账号已删除，释放 ${result.released_players} 名球员、移除 ${result.deleted_bids} 条报价，返还 ${money(result.refunded_amount)}`);
    await Promise.all([loadAdmin(), loadPlayers(), refreshAuction()]);
  } catch (error) { toast(error.message, "error"); }
}

async function releasePlayer(teamId, playerId) {
  const item = state.adminRoster?.roster.find(entry => String(entry.player.id) === String(playerId));
  if (!item) return;
  if (!window.confirm(`确认从“${state.adminRoster.team.name}”释放 ${item.player.name_zh}？球员将退回球员库，并返还原成交价 ${money(item.acquired_price)}。`)) return;
  try {
    const result = await api("admin/player/release", { method: "POST", body: JSON.stringify({ team_id: teamId, player_id: playerId }) });
    toast(`${result.player_name} 已释放，返还 ${money(result.refunded_amount)}`);
    state.adminRoster = await api(`roster?team_id=${encodeURIComponent(teamId)}`);
    renderAdminRoster();
    await Promise.all([loadAdmin(), loadPlayers(), refreshAuction()]);
  } catch (error) { toast(error.message, "error"); }
}

function renderAdminPool() {
  if (!state.auction) return;
  const active = state.auction.active;
  $("#admin-pool-list").innerHTML = `${active ? `<div class="admin-pool-row active-admin-pool-row">${imageMarkup(active.player)}<div><b>${escapeHtml(active.player.name_zh)}</b><small>${active.auction_type === "sealed" ? "暗拍" : "明拍"}进行中 · ${active.auction_type === "sealed" ? active.bid_count : active.bids.length} ${active.auction_type === "sealed" ? "支球队已报价" : "次报价"}</small></div><span>${active.auction_type === "sealed" ? "金额保密" : money(active.bids[0]?.amount ?? active.start_price)}</span><div class="admin-auction-actions"><button data-settle-auction>落槌成交</button><button data-withdraw-auction class="danger-action">撤回拍卖</button></div></div>` : ""}${state.auction.queued.map(item => `<div class="admin-pool-row">${imageMarkup(item.player)}<div><b>${escapeHtml(item.player.name_zh)}</b><small>${item.auction_type === "sealed" ? "暗拍" : "明拍"} · ${item.duration_seconds} 秒 · 起拍 ${money(item.start_price)}${item.auction_type === "open" ? ` · 每次 +${money(item.min_increment)}` : ""}</small></div><span>#${item.id}</span><button data-start-auction="${item.id}" ${active ? "disabled" : ""}>开始竞拍</button></div>`).join("") || (!active ? `<div class="empty-copy">先把球员加入拍卖池</div>` : "")}`;
  $$('[data-start-auction]').forEach(button => button.onclick = () => startAuction(button.dataset.startAuction));
  $$('[data-settle-auction]', $("#admin-pool-list")).forEach(button => button.onclick = settleAuction);
  $$('[data-withdraw-auction]', $("#admin-pool-list")).forEach(button => button.onclick = withdrawAuction);
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

async function settleAuction() {
  if (!window.confirm("确认现在落槌成交？系统将以当前最高有效报价立即结算。")) return;
  try {
    await api("admin/auction/settle", { method: "POST", body: "{}" });
    toast("已落槌成交");
    await refreshAuction();
  } catch (error) { toast(error.message, "error"); }
}

async function withdrawAuction() {
  if (!window.confirm("确认撤回本轮拍卖？本轮全部报价会清空，球员退回待拍池。")) return;
  try {
    await api("admin/auction/withdraw", { method: "POST", body: "{}" });
    toast("拍卖已撤回，球员已退回待拍池");
    await refreshAuction();
  } catch (error) { toast(error.message, "error"); }
}

async function queueAuction(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  ["start_price", "min_increment", "duration_seconds"].forEach(key => data[key] = Number(data[key]));
  data.start_immediately = state.queueStartImmediately;
  try {
    const result = await api("admin/auction/queue", { method: "POST", body: JSON.stringify(data) });
    toast(result.status === "active" ? "竞拍已开始，参与者端正在同步" : "球员已加入拍卖池");
    $("#queue-dialog").close();
    state.queueSelection = null;
    await Promise.all([loadPlayers(), refreshAuction()]);
    renderAdminPool();
    if (result.status === "active") navigate("market");
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
[$("#history-type-filter"), $("#history-status-filter")].forEach(element => element.onchange = renderAuctionHistory);
$("#player-search").oninput = () => { state.playerPage = 1; renderPlayers(); };
$("#roster-group").onchange = event => { state.rosterGroup = event.currentTarget.value; renderRoster(); };
$("#roster-sort").onchange = event => { state.rosterSort = event.currentTarget.value; renderRoster(); };
$("#match-form").onsubmit = saveMatch;
$("#match-stage").onchange = event => {
  const knockout = event.currentTarget.value === "knockout";
  if (knockout && $("#match-round-name").value === "小组赛") $("#match-round-name").value = "1/4 决赛";
  if (!knockout && !$("#match-group-name").value) $("#match-group-name").value = "A组";
  updateMatchStageFields();
};
$("#match-cancel-edit").onclick = () => { state.editingMatchId = null; renderMatchEditor(); };
$("#match-stat-team").onchange = event => { state.matchStatSideTeamId = Number(event.currentTarget.value); renderMatchStatCandidates(); };
$("#match-stat-search").oninput = renderMatchStatCandidates;
$("#match-stat-save").onclick = saveMatchStats;
$("#match-stat-dialog .dialog-close").onclick = () => $("#match-stat-dialog").close();
$("#match-stat-dialog").onclick = event => { if (event.target === $("#match-stat-dialog")) $("#match-stat-dialog").close(); };
$$('[data-trade-parties]').forEach(button => button.onclick = () => {
  state.tradePartyCount = Number(button.dataset.tradeParties);
  renderTradeBuilder();
});
$("#submit-trade").onclick = submitTrade;
$("#queue-form").onsubmit = queueAuction;
$("#open-queue-dialog").onclick = () => openQueueDialog(false);
$("#market-queue-shortcut").onclick = () => openQueueDialog(true);
$("#queue-dialog .dialog-close").onclick = () => { state.drawRevealToken += 1; state.drawingPlayer = false; $("#queue-dialog").close(); };
$("#queue-dialog").onclick = event => { if (event.target === $("#queue-dialog")) { state.drawRevealToken += 1; state.drawingPlayer = false; $("#queue-dialog").close(); } };
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
$("#bid-confirm-submit").onclick = confirmBid;
$("#bid-confirm-cancel").onclick = () => { state.pendingBid = null; $("#bid-confirm-dialog").close(); };
$("#bid-confirm-dialog .dialog-close").onclick = () => { state.pendingBid = null; $("#bid-confirm-dialog").close(); };
$("#bid-confirm-dialog").onclick = event => { if (event.target === $("#bid-confirm-dialog")) { state.pendingBid = null; $("#bid-confirm-dialog").close(); } };
$("#player-dialog .dialog-close").onclick = () => $("#player-dialog").close();
$("#player-dialog").onclick = event => { if (event.target === $("#player-dialog")) $("#player-dialog").close(); };
$("#admin-roster-dialog .dialog-close").onclick = () => $("#admin-roster-dialog").close();
$("#admin-roster-dialog").onclick = event => { if (event.target === $("#admin-roster-dialog")) $("#admin-roster-dialog").close(); };
$("#team-name-form").onsubmit = saveTeamName;
$("#team-dialog .dialog-close").onclick = () => $("#team-dialog").close();
$("#team-dialog").onclick = event => { if (event.target === $("#team-dialog")) $("#team-dialog").close(); };

bootstrap().catch(error => toast(error.message, "error"));
