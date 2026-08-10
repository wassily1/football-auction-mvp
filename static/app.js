const state = {
  user: null,
  players: [],
  auction: null,
  roster: null,
  page: "market",
  poolTab: "queued",
  queueTab: "search",
  queueSelection: null,
  lastSettlementId: null,
  pollTimer: null,
  toastTimer: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = value => `${Number(value || 0).toLocaleString("zh-CN")} 万`;
const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));

async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "请求失败");
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
  startPolling();
}

function renderUserBar() {
  $("#user-bar").innerHTML = `<div class="user-chip"><i>${escapeHtml(state.user.username[0].toUpperCase())}</i><div><b>${escapeHtml(state.user.username)}</b><small>${state.user.role === "admin" ? "管理员" : `${escapeHtml(state.user.team_name)} · ${money(state.user.funds)}`}</small></div></div><button id="logout-button" class="link-button">退出</button>`;
  $("#logout-button").onclick = logout;
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
  $$(".page").forEach(element => element.classList.remove("active-page"));
  $(`#${page}-page`)?.classList.add("active-page");
  $$("#main-nav button").forEach(button => button.classList.toggle("active", button.dataset.page === page));
  window.scrollTo({ top: 0, behavior: "instant" });
  if (page === "players") renderPlayers();
  if (page === "lineup") loadRoster();
  if (page === "admin") loadAdmin();
}

function startPolling() {
  clearInterval(state.pollTimer);
  refreshAuction();
  state.pollTimer = setInterval(refreshAuction, 1000);
}

async function logout() {
  await api("logout", { method: "POST", body: "{}" });
  clearInterval(state.pollTimer);
  state.user = null;
  showAuth();
}

async function loadPlayers() {
  const result = await api("players");
  state.players = result.players;
  renderPlayers();
  renderQueueDialog();
}

function renderPlayers() {
  if (!state.players.length) return;
  const search = $("#player-search").value.trim().toLowerCase();
  const position = $("#position-filter").value;
  const players = state.players.filter(player => {
    const nameMatch = `${player.name_zh} ${player.name_en}`.toLowerCase().includes(search);
    const positionMatch = !position || [player.primary_position, ...player.secondary_positions].includes(position);
    return nameMatch && positionMatch;
  });
  $("#player-count").textContent = `显示 ${players.length} / ${state.players.length}`;
  $("#player-grid").innerHTML = players.map(player => `
    <button class="player-card" data-player-id="${player.id}">
      <div class="player-card-photo">${imageMarkup(player)}</div>
      <span class="player-score">${player.overall}</span><span class="player-position">${escapeHtml(player.primary_position)}</span>
      <span class="player-owner">${escapeHtml(player.team_name || "未归属")}</span>
      <div class="player-card-body"><h3>${escapeHtml(player.name_zh)}</h3><p>${escapeHtml(player.name_en)}</p>${statsMarkup(player, "mini-stats")}</div>
    </button>`).join("");
  $$(".player-card", $("#player-grid")).forEach(card => card.onclick = () => openPlayer(card.dataset.playerId));
}

function openPlayer(playerId) {
  const player = state.players.find(item => String(item.id) === String(playerId))
    || state.auction?.active?.player
    || state.roster?.roster.find(item => String(item.player.id) === String(playerId))?.player;
  if (!player) return;
  const labels = Object.keys(player.stats);
  const values = Object.values(player.stats);
  $("#player-detail").innerHTML = `
    <div class="detail-grid">
      <div class="detail-photo">${imageMarkup(player)}</div>
      <div class="detail-copy"><p class="eyebrow">${escapeHtml(player.category)} · ${escapeHtml(player.primary_position)}</p><h2>${escapeHtml(player.name_zh)}</h2><p>${escapeHtml(player.name_en)}</p>
        ${statsMarkup(player, "detail-stats")}
        <div class="radar-wrap">${radarMarkup(labels, values)}<div class="detail-meta"><span>综合评分 <b>${player.overall}</b></span><span>身高 / 体重 <b>${player.height_cm || "-"} cm / ${player.weight_kg || "-"} kg</b></span><span>花式 / 逆足 <b>${player.skill_moves}★ / ${player.weak_foot}★</b></span><span>副位置 <b>${escapeHtml(player.secondary_positions.join(" / ") || "无")}</b></span><div class="ability-row">${player.gold_abilities.map(item => `<span class="ability">◆ ${escapeHtml(item)}</span>`).join("")}${player.silver_abilities.map(item => `<span class="ability silver">◇ ${escapeHtml(item)}</span>`).join("")}</div></div></div>
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
    $("#market-sync").textContent = "连接中断";
    $("#market-sync").classList.remove("live");
  }
}

function renderAuction() {
  const { active, queued, server_time: serverTime } = state.auction;
  renderAuctionPool();
  if (!active) {
    $("#auction-player-card").className = "auction-player-card empty-player-card";
    $("#auction-player-card").innerHTML = `<div><span>NO ACTIVE LOT</span><strong>等待拍品</strong><small>管理员开启竞拍后，球员完整信息会显示在这里。</small></div>`;
    $("#auction-stage").className = "auction-stage empty-stage";
    $("#auction-stage").innerHTML = `<div class="waiting-stage"><p class="eyebrow">WAITING ROOM</p><h2>等待管理员开启下一场竞拍</h2><p>拍卖池中还有 ${queued.length} 名球员</p></div>`;
    renderBidSeats([], state.auction.teams || []);
    renderBidHistory([]);
    $("#bid-count").textContent = "0 次报价";
    return;
  }
  const player = active.player;
  const topBid = active.bids[0]?.amount;
  const minimum = topBid == null ? active.start_price : topBid + active.min_increment;
  const canBid = state.user.role === "participant";
  const remaining = Math.max(0, active.ends_at - serverTime);
  const progress = Math.min(1, remaining / active.duration_seconds);
  $("#auction-player-card").className = "auction-player-card";
  $("#auction-player-card").innerHTML = playerShowcaseMarkup(player);
  $("#auction-player-card").onclick = () => openPlayer(player.id);
  $("#auction-stage").className = "auction-stage";
  $("#auction-stage").innerHTML = `
    <div class="auction-mode"><span class="active">明拍</span><span>实时竞价</span></div>
    <div class="countdown-orbit" style="--progress:${progress}"><div><small>剩余时间</small><strong id="countdown">${formatCountdown(remaining)}</strong><span>${remaining <= 10 ? "即将落槌" : "每次报价实时同步"}</span></div></div>
    <div class="live-price"><small>当前最高价</small><strong>${money(topBid ?? active.start_price)}</strong><span>${topBid == null ? "等待第一份报价" : escapeHtml(active.bids[0].team_name)}</span></div>
    ${canBid ? `<form id="bid-form" class="bid-form live-bid-form"><input name="amount" type="number" min="${minimum}" value="${minimum}" step="${active.min_increment}" required><button class="primary-button" type="submit">确认报价</button></form><p class="spectator-note">最低有效报价 ${money(minimum)} · 我的余额 ${money(state.user.funds)}</p>` : `<p class="spectator-note">管理员视角 · 所有参与者报价正在实时同步</p>`}`;
  if (canBid) $("#bid-form").onsubmit = submitBid;
  renderBidSeats(active.bids, state.auction.teams || []);
  renderBidHistory(active.bids);
}

function playerShowcaseMarkup(player) {
  return `<div class="showcase-head"><div><strong>${player.overall}</strong><span>${escapeHtml(player.primary_position)}</span></div><em>${escapeHtml(player.category)}</em></div>
    <div class="showcase-photo">${imageMarkup(player)}</div>
    <div class="showcase-name"><small>${escapeHtml(player.name_en)}</small><h2>${escapeHtml(player.name_zh)}</h2></div>
    <div class="showcase-data">${radarMarkup(Object.keys(player.stats), Object.values(player.stats))}${statsMarkup(player, "showcase-stats")}</div>
    <div class="showcase-traits"><span>花式 ${player.skill_moves}★</span><span>逆足 ${player.weak_foot}★</span>${player.gold_abilities.slice(0, 2).map(value => `<b>◆ ${escapeHtml(value)}</b>`).join("")}${player.silver_abilities.slice(0, 2).map(value => `<b class="silver">◇ ${escapeHtml(value)}</b>`).join("")}</div>`;
}

function formatCountdown(seconds) {
  const safe = Math.max(0, seconds);
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
    return `<div class="seat-card ${leaderId === team.id ? "leader" : ""}"><i>${escapeHtml(team.name.slice(0, 1))}</i><div><b>${escapeHtml(team.name)}</b><small>${bid ? `${new Date(bid.created_at * 1000).toLocaleTimeString("zh-CN")} 出价` : "等待出价"}</small><span>余额 ${money(team.funds)}</span></div><strong>${bid ? money(bid.amount) : "—"}</strong>${leaderId === team.id ? `<em>领先</em>` : ""}</div>`;
  }).join("") : `<div class="empty-copy">参与者创建球队后会出现在竞价席</div>`;
}

function renderBidHistory(bids) {
  $("#bid-history").innerHTML = bids.length ? bids.map((bid, index) => `<div class="history-row"><span>${String(index + 1).padStart(2, "0")}</span><div><b>${escapeHtml(bid.team_name)}</b><small>${new Date(bid.created_at * 1000).toLocaleTimeString("zh-CN")}</small></div><strong>${money(bid.amount)}</strong></div>`).join("") : `<div class="empty-copy">报价记录会按价格显示</div>`;
}

async function submitBid(event) {
  event.preventDefault();
  const button = $("button", event.currentTarget);
  button.disabled = true;
  try {
    const amount = Number(new FormData(event.currentTarget).get("amount"));
    await api("bid", { method: "POST", body: JSON.stringify({ amount }) });
    toast(`报价 ${money(amount)} 已进入竞价席`);
    await refreshAuction();
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
}

function poolCard(item) {
  const player = item.player;
  return `<div class="pool-card">${imageMarkup(player)}<div><b>${escapeHtml(player.name_zh)}</b><small>${player.overall} · ${escapeHtml(player.primary_position)} · 起拍 ${money(item.start_price)}</small></div><span>#${item.id}</span></div>`;
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
  $("#settlement-content").innerHTML = `<p class="eyebrow">本轮${sold ? "成交" : "结束"}</p><h2>${sold ? "拍 中" : "流 拍"}</h2>${sold ? `<div class="settlement-team"><i>${escapeHtml(result.winner_team_name.slice(0, 1))}</i><strong>${escapeHtml(result.winner_team_name)}</strong></div>` : ""}<p>${escapeHtml(result.player.name_zh)}${sold ? ` · ${money(result.final_price)}` : " · 无人出价"}</p>`;
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
  const starters = state.roster.roster.filter(item => item.lineup_role === "starter");
  const bench = state.roster.roster.filter(item => item.lineup_role === "bench");
  $("#starters").innerHTML = starters.map((item, index) => fieldPlayer(item, index, starters)).join("");
  $("#bench").innerHTML = bench.length ? bench.map(item => `<button class="bench-player" data-player-id="${item.player.id}">${imageMarkup(item.player)}<span><b>${escapeHtml(item.player.name_zh)}</b><small>${item.player.overall} · ${escapeHtml(item.player.primary_position)} · ${money(item.acquired_price)}</small></span><em>加入首发</em></button>`).join("") : `<div class="empty-copy">成交球员会先进入替补席</div>`;
  $$("[data-player-id]", $("#lineup-page")).forEach(element => element.onclick = () => toggleLineup(element.dataset.playerId));
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

function availableQueuePlayers() {
  const blocked = new Set((state.auction?.queued || []).map(item => String(item.player_id)));
  if (state.auction?.active) blocked.add(String(state.auction.active.player_id));
  return state.players.filter(player => !player.owned && !blocked.has(String(player.id)));
}

function renderQueueDialog() {
  if (!$("#queue-dialog") || !state.players.length) return;
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
    $("#admin-teams").innerHTML = result.teams.length ? result.teams.map(team => `<div class="admin-team-row"><div><b>${escapeHtml(team.name)}</b><small>球队 #${team.id}</small></div><input type="number" min="0" value="${team.funds}" data-funds-team="${team.id}"><button data-save-funds="${team.id}">保存</button></div>`).join("") : `<div class="empty-copy">参与者注册后会出现在这里</div>`;
    $$('[data-save-funds]').forEach(button => button.onclick = () => saveFunds(button.dataset.saveFunds));
    renderAdminPool();
  } catch (error) { toast(error.message, "error"); }
}

async function saveFunds(teamId) {
  const funds = Number($(`[data-funds-team="${teamId}"]`).value);
  try {
    await api("admin/funds", { method: "POST", body: JSON.stringify({ team_id: Number(teamId), funds }) });
    toast("球队资金已更新");
    await loadAdmin();
  } catch (error) { toast(error.message, "error"); }
}

function renderAdminPool() {
  if (!state.auction) return;
  const active = state.auction.active;
  $("#admin-pool-list").innerHTML = `${active ? `<div class="admin-pool-row">${imageMarkup(active.player)}<div><b>${escapeHtml(active.player.name_zh)}</b><small>正在竞拍 · ${active.bids.length} 次报价</small></div><span>${money(active.bids[0]?.amount ?? active.start_price)}</span><button disabled>进行中</button></div>` : ""}${state.auction.queued.map(item => `<div class="admin-pool-row">${imageMarkup(item.player)}<div><b>${escapeHtml(item.player.name_zh)}</b><small>${item.duration_seconds} 秒 · 起拍 ${money(item.start_price)} · 每次 +${money(item.min_increment)}</small></div><span>#${item.id}</span><button data-start-auction="${item.id}" ${active ? "disabled" : ""}>开始竞拍</button></div>`).join("") || (!active ? `<div class="empty-copy">先把球员加入拍卖池</div>` : "")}`;
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
$("#player-search").oninput = renderPlayers;
$("#position-filter").onchange = renderPlayers;
$("#queue-form").onsubmit = queueAuction;
$("#open-queue-dialog").onclick = openQueueDialog;
$("#queue-dialog .dialog-close").onclick = () => $("#queue-dialog").close();
$("#queue-dialog").onclick = event => { if (event.target === $("#queue-dialog")) $("#queue-dialog").close(); };
$$('[data-queue-tab]').forEach(button => button.onclick = () => switchQueueTab(button.dataset.queueTab));
$("#queue-search").oninput = renderQueueSearch;
[$("#random-min-rating"), $("#random-max-rating"), $("#random-position"), $("#random-category")].forEach(element => {
  element.oninput = renderRandomOptions;
  element.onchange = renderRandomOptions;
});
$("#draw-player").onclick = drawRandomPlayer;
$$('[data-pool-tab]').forEach(button => button.onclick = () => { state.poolTab = button.dataset.poolTab; renderAuctionPool(); });
$("#settlement-close").onclick = () => $("#settlement-dialog").close();
$("#settlement-dialog").onclick = event => { if (event.target === $("#settlement-dialog")) $("#settlement-dialog").close(); };
$("#player-dialog .dialog-close").onclick = () => $("#player-dialog").close();
$("#player-dialog").onclick = event => { if (event.target === $("#player-dialog")) $("#player-dialog").close(); };

bootstrap().catch(error => toast(error.message, "error"));
