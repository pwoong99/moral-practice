// ============================================================
//  도덕 실천 기록장 — 메인 스크립트
//  만든이 : 푸르이든
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut,
  connectAuthEmulator
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, writeBatch, serverTimestamp, deleteField, getDocs,
  connectFirestoreEmulator
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, TEACHER_EMAIL, CLASS_NAME, PIN_PREFIX } from "./firebase-config.js";

const VERSION = "v1.1";

// ---------- Firebase ----------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const USE_EMU = ["localhost", "127.0.0.1"].includes(location.hostname)
  && new URLSearchParams(location.search).has("emu");
if (USE_EMU) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

// ---------- 상태 ----------
const S = {
  role: null,          // 'login' | 'student' | 'teacher'
  uid: null,
  sid: null,           // 로그인한 학생 번호(문서 id, 예: "07")
  students: [],
  rounds: [],
  autoDone: {},
  practices: [],
  cheers: [],
  pins: {},
  rid: null,
  tab: null,
  loginMode: "student",
  showPins: false,
  modal: null,
  unsubs: [],
  roundUnsubs: [],
};

const MARKS = { O: "O", T: "△", X: "X" };
const SCORE = { O: 1, T: 0.5, X: 0 };
const EMOJIS = ["👍", "💪", "🌟", "👏", "❤️", "🔥", "🌱", "😊"];
const WEEK = ["일", "월", "화", "수", "목", "금", "토"];

// ---------- 유틸 ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad2 = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const today = () => fmt(new Date());
const md = (s) => { const d = parse(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
const mdw = (s) => { const d = parse(s); return `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`; };
// 비밀번호 규칙: 학년반(PIN_PREFIX) + 번호 두 자리  예) 6학년 3반 1번 → 6301
const pinFor = (num) => `${PIN_PREFIX || ""}${pad2(Number(num))}`.slice(-4).padStart(4, "0");
const sidOf = (num) => pad2(Number(num));

function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
}

function errMsg(e) {
  const c = e?.code || "";
  if (c.includes("permission-denied")) return "권한이 없어요. (회차가 종료되었거나 로그인이 풀렸을 수 있어요)";
  if (c.includes("unavailable")) return "인터넷 연결을 확인해 주세요.";
  return "오류가 났어요: " + (e?.message || e);
}

function roundDays(r) {
  const out = [];
  if (!r?.start || !r?.end) return out;
  const d = parse(r.start), e = parse(r.end);
  for (let i = 0; d <= e && i < 400; i++) {
    const w = d.getDay();
    if (r.weekends !== false || (w !== 0 && w !== 6)) out.push(fmt(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function practiceStats(p, r) {
  const days = roundDays(r);
  const t = today();
  const passed = days.filter((d) => d <= t);
  const checks = p.checks || {};
  let O = 0, T = 0, X = 0, score = 0;
  passed.forEach((d) => {
    const m = checks[d];
    if (m === "O") O++; else if (m === "T") T++; else if (m === "X") X++;
    if (m) score += SCORE[m];
  });
  const none = passed.length - O - T - X;
  const rate = passed.length ? Math.round((score / passed.length) * 100) : null;
  return { days, passed, O, T, X, none, rate };
}

const studentName = (sid) => S.students.find((s) => s.id === sid)?.name || "(알 수 없음)";
const currentRound = () => S.rounds.find((r) => r.id === S.rid) || null;
const isOpen = (r) => r && r.status === "open";

function sortRounds(list) {
  return list.sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    return (b.start || "").localeCompare(a.start || "");
  });
}

function roundBadge(r) {
  if (r.status !== "open") return `<span class="badge badge-closed">종료</span>`;
  if (r.start && today() < r.start) return `<span class="badge badge-ready">시작 전</span>`;
  return `<span class="badge badge-open">진행중</span>`;
}

// ---------- 구독 관리 ----------
function stopAll() {
  S.unsubs.forEach((u) => u()); S.unsubs = [];
  stopRound();
  S.rid = null;
}
function stopRound() {
  S.roundUnsubs.forEach((u) => u()); S.roundUnsubs = [];
  S.practices = []; S.cheers = [];
}
const snapErr = (e) => { console.error(e); toast(errMsg(e)); };

function listenCommon() {
  S.unsubs.push(onSnapshot(collection(db, "students"), (snap) => {
    S.students = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.num || 0) - (b.num || 0));
    render();
  }, snapErr));
  S.unsubs.push(onSnapshot(collection(db, "rounds"), (snap) => {
    S.rounds = sortRounds(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    if (!S.rounds.find((r) => r.id === S.rid)) {
      const saved = localStorage.getItem("mp_rid");
      const pick = S.rounds.find((r) => r.id === saved) || S.rounds[0];
      selectRound(pick ? pick.id : null, true);
    }
    render();
  }, snapErr));
}

function selectRound(rid, silent) {
  if (S.rid === rid && S.roundUnsubs.length) return;
  stopRound();
  S.rid = rid;
  if (rid) localStorage.setItem("mp_rid", rid);
  if (rid && S.role !== "login") {
    S.roundUnsubs.push(onSnapshot(query(collection(db, "practices"), where("rid", "==", rid)), (snap) => {
      S.practices = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => ((a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0)) || ((a.order || 0) - (b.order || 0)));
      render();
      if (S.role === "student" && !snap.metadata.fromCache) autoCreatePresets();
    }, snapErr));
    S.roundUnsubs.push(onSnapshot(query(collection(db, "cheers"), where("rid", "==", rid)), (snap) => {
      S.cheers = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
      render();
    }, snapErr));
  }
  if (!silent) render();
}

// ---------- 인증 흐름 ----------
onAuthStateChanged(auth, async (user) => {
  stopAll();
  S.rid = null; S.modal = null;
  if (!user) {
    S.role = null;
    try { await signInAnonymously(auth); }
    catch (e) {
      $("#app").innerHTML = `<div class="empty">Firebase에 연결하지 못했어요.<br>
        (Authentication에서 '익명' 로그인을 켰는지 확인해 주세요)<br><span class="muted">${esc(e.code || e.message)}</span></div>`;
    }
    return;
  }
  S.uid = user.uid;
  if (!user.isAnonymous) {
    if ((user.email || "").toLowerCase() === TEACHER_EMAIL.toLowerCase()) {
      S.role = "teacher"; S.tab = "status";
      listenCommon();
      S.unsubs.push(onSnapshot(collection(db, "pins"), (snap) => {
        S.pins = {}; snap.docs.forEach((d) => (S.pins[d.id] = d.data().pin));
        render();
      }, snapErr));
      render();
    } else {
      toast("교사 계정이 아니에요.");
      await signOut(auth);
    }
    return;
  }
  // 익명 사용자 → 세션 확인
  try {
    const ses = await getDoc(doc(db, "sessions", user.uid));
    if (ses.exists()) {
      const st = await getDoc(doc(db, "students", ses.data().sid));
      if (st.exists()) { enterStudent(ses.data().sid); return; }
      await deleteDoc(doc(db, "sessions", user.uid)).catch(() => {});
    }
  } catch (e) { console.warn(e); }
  enterLogin();
});

function enterLogin() {
  stopAll();
  S.role = "login"; S.sid = null; S.modal = null;
  S.unsubs.push(onSnapshot(collection(db, "students"), (snap) => {
    S.students = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.num || 0) - (b.num || 0));
    render();
  }, snapErr));
  render();
}

function enterStudent(sid) {
  stopAll();
  S.role = "student"; S.sid = sid; S.tab = S.tab === "board" ? "board" : "mine"; S.modal = null;
  listenCommon();
  render();
}

async function studentLogin() {
  const sid = $("#loginSid").value;
  const pin = $("#loginPin").value.trim();
  const err = $("#loginErr");
  if (!sid) { err.textContent = "번호를 골라 주세요."; return; }
  if (!/^\d{4}$/.test(pin)) { err.textContent = "비밀번호 숫자 4자리를 입력해 주세요."; return; }
  err.textContent = "확인 중…";
  try {
    await setDoc(doc(db, "sessions", auth.currentUser.uid), { sid, pin, at: serverTimestamp() });
    enterStudent(sid);
    toast(`${studentName(sid)}, 반가워요!`);
  } catch (e) {
    err.textContent = e.code?.includes("permission-denied") ? "비밀번호가 맞지 않아요." : errMsg(e);
  }
}

async function teacherLogin() {
  const email = $("#tEmail").value.trim().toLowerCase();
  const pw = $("#tPw").value;
  const err = $("#loginErr");
  err.textContent = "확인 중…";
  try { await signInWithEmailAndPassword(auth, email, pw); }
  catch (e) {
    const c = e?.code || "";
    const msg = {
      "auth/operation-not-allowed": "Firebase에서 '이메일/비밀번호' 로그인이 꺼져 있어요. (Authentication > 로그인 방법에서 사용 설정)",
      "auth/invalid-credential": "이메일 또는 비밀번호가 맞지 않아요. (Authentication > Users에 이 계정이 있는지도 확인)",
      "auth/wrong-password": "비밀번호가 맞지 않아요.",
      "auth/user-not-found": "이 이메일로 만든 계정이 없어요. (Authentication > Users에서 사용자 추가)",
      "auth/invalid-email": "이메일 형식이 맞지 않아요.",
      "auth/too-many-requests": "여러 번 틀려서 잠시 막혔어요. 몇 분 뒤 다시 해 주세요.",
      "auth/network-request-failed": "인터넷 연결을 확인해 주세요.",
      "auth/api-key-not-valid.-please-pass-a-valid-api-key.": "firebase-config.js의 apiKey가 맞지 않아요.",
    }[c];
    err.textContent = (msg || "로그인하지 못했어요.") + ` [${c || e?.message || e}]`;
  }
}

async function logout() {
  if (S.role === "teacher") { S.loginMode = "student"; await signOut(auth); return; }
  try { await deleteDoc(doc(db, "sessions", auth.currentUser.uid)); } catch (e) { console.warn(e); }
  enterLogin();
}

// ============================================================
//  렌더링
// ============================================================
function preserve(root, fn) {
  const vals = {};
  root.querySelectorAll("input[id], textarea[id], select[id]").forEach((el) => {
    vals[el.id] = el.type === "checkbox" ? el.checked : el.value;
  });
  const active = document.activeElement?.id;
  let selStart = null;
  try { selStart = document.activeElement?.selectionStart; } catch (_) {}
  fn();
  Object.entries(vals).forEach(([id, v]) => {
    const el = document.getElementById(id);
    if (!el || (el.dataset.fresh && el.id !== active)) return;
    if (el.type === "checkbox") el.checked = v; else el.value = v;
  });
  if (active) {
    const el = document.getElementById(active);
    if (el) { el.focus(); try { if (selStart != null) el.setSelectionRange(selStart, selStart); } catch (_) {} }
  }
}

function render() {
  $("#appVersion").textContent = VERSION;
  $("#brandSub").textContent = CLASS_NAME;
  renderTopbar();
  const root = $("#app");
  preserve(root, () => {
    if (S.role === "login") root.innerHTML = loginHtml();
    else if (S.role === "student") root.innerHTML = studentHtml();
    else if (S.role === "teacher") root.innerHTML = teacherHtml();
  });
  renderModal();
}

function renderTopbar() {
  const el = $("#topbarRight");
  if (S.role === "student") {
    const st = S.students.find((s) => s.id === S.sid);
    el.innerHTML = `<span class="who">${st ? `${st.num}번 ${esc(st.name)}` : ""}</span>
      <button class="btn btn-sm" data-act="open-pin">비밀번호 변경</button>
      <button class="btn btn-sm" data-act="logout">나가기</button>`;
  } else if (S.role === "teacher") {
    el.innerHTML = `<span class="who">👩‍🏫 교사</span>
      <button class="btn btn-sm" data-act="logout">로그아웃</button>`;
  } else el.innerHTML = "";
}

// ---------- 로그인 ----------
function loginHtml() {
  if (S.loginMode === "teacher") {
    return `<div class="login-wrap"><div class="login-card">
      <h2>교사 로그인</h2><p class="sub">교사용 이메일 계정으로 로그인하세요</p>
      <div class="field"><label>이메일</label><input id="tEmail" type="email" autocomplete="username"></div>
      <div class="field"><label>비밀번호</label><input id="tPw" type="password" autocomplete="current-password" data-enter="teacher-login"></div>
      <div class="err" id="loginErr"></div>
      <button class="btn btn-primary" data-act="teacher-login">로그인</button>
      <div class="login-foot"><button class="btn-link" data-act="login-mode" data-mode="student">← 학생 로그인으로</button></div>
    </div></div>`;
  }
  const opts = S.students.filter((s) => s.active !== false)
    .map((s) => `<option value="${s.id}">${s.num}번 ${esc(s.name)}</option>`).join("");
  return `<div class="login-wrap"><div class="login-card">
    <h2>나의 실천 기록장</h2><p class="sub">번호를 고르고 비밀번호 4자리를 입력하세요</p>
    ${S.students.length ? "" : `<div class="empty" style="padding:16px;margin-bottom:12px">아직 학생 명단이 없어요.<br>선생님이 명단을 등록하면 로그인할 수 있어요.</div>`}
    <div class="field"><label>번호</label><select id="loginSid"><option value="">번호 선택</option>${opts}</select></div>
    <div class="field"><label>비밀번호</label>
      <input id="loginPin" class="pin-input" type="password" inputmode="numeric" maxlength="4" autocomplete="off" data-enter="student-login"></div>
    <div class="err" id="loginErr"></div>
    <button class="btn btn-primary" data-act="student-login">들어가기</button>
    <div class="login-foot"><button class="btn-link" data-act="login-mode" data-mode="teacher">교사 로그인</button></div>
  </div></div>`;
}

// ---------- 공통: 회차 선택줄 ----------
function roundBarHtml() {
  if (!S.rounds.length) return "";
  const r = currentRound();
  const opts = S.rounds.map((x) =>
    `<option value="${x.id}" ${x.id === S.rid ? "selected" : ""}>${x.status === "open" ? "" : "[종료] "}${esc(x.title)}</option>`).join("");
  return `<div class="round-bar">
      <select id="roundSel" data-change="round">${opts}</select>
      ${r ? roundBadge(r) : ""}
      ${r ? `<span class="round-info">${mdw(r.start)} ~ ${mdw(r.end)} · ${roundDays(r).length}일${r.weekends === false ? " (주말 제외)" : ""}</span>` : ""}
    </div>
    ${r?.desc ? `<div class="round-desc">📌 ${esc(r.desc)}</div>` : ""}`;
}

// ---------- 공통: 실천 카드 ----------
function dayGridHtml(p, r, editable) {
  const t = today();
  const checks = p.checks || {};
  return `<div class="day-grid">${roundDays(r).map((d) => {
    const m = checks[d];
    const future = d > t;
    const w = parse(d).getDay();
    const cls = ["day", m ? `m-${m}` : "", future ? "future" : "", d === t ? "is-today" : "",
      !m && !future ? "missed" : "", w === 0 || w === 6 ? "weekend" : "",
      editable && !future ? "clickable" : ""].join(" ");
    const act = editable && !future ? `data-act="cycle" data-pid="${p.id}" data-date="${d}"` : "";
    return `<div class="${cls}" ${act} title="${mdw(d)}"><span class="d-date">${md(d)}</span><span class="d-mark">${m ? MARKS[m] : future ? "" : "·"}</span></div>`;
  }).join("")}</div>`;
}

function rateHtml(st) {
  if (st.rate == null) return `<div class="rate-row"><span class="muted">아직 실천 기간이 시작되지 않았어요</span></div>`;
  return `<div class="rate-row">
    <span class="counts"><span>O <b>${st.O}</b></span><span>△ <b>${st.T}</b></span><span>X <b>${st.X}</b></span><span>미기록 <b>${st.none}</b></span></span>
    <div class="bar"><span style="width:${st.rate}%"></span></div>
    <span class="rate-num">${st.rate}%</span></div>`;
}

function cheerChipsHtml(pid) {
  const list = S.cheers.filter((c) => c.pid === pid);
  if (!list.length) return "";
  return `<div class="cheer-strip">${list.map((c) => {
    const canDel = S.role === "teacher" || c.fromSid === S.sid;
    return `<span class="cheer-chip">${esc(c.emoji)} ${esc(c.text)} <span class="from">— ${esc(studentName(c.fromSid))}</span>
      ${canDel ? `<button class="x" data-act="del-cheer" data-cid="${c.id}" title="지우기">✕</button>` : ""}</span>`;
  }).join("")}</div>`;
}

function cheerBoxHtml(pid) {
  const sel = S.modal?.emoji?.[pid] || EMOJIS[0];
  return `<div class="cheer-box">
    <div class="emoji-row">${EMOJIS.map((e) =>
      `<button class="emoji-btn ${e === sel ? "sel" : ""}" data-act="pick-emoji" data-pid="${pid}" data-emoji="${e}">${e}</button>`).join("")}</div>
    <div class="cheer-input-row">
      <input id="cheer-${pid}" maxlength="60" placeholder="응원 한마디 (선택, 60자까지)" data-enter="send-cheer" data-pid="${pid}">
      <button class="btn btn-terra" data-act="send-cheer" data-pid="${pid}">응원하기</button>
    </div></div>`;
}

function practiceCardHtml(p, r, opt = {}) {
  const st = practiceStats(p, r);
  const t = today();
  const showToday = opt.editable && st.days.includes(t);
  const cur = (p.checks || {})[t];
  return `<div class="practice-card">
    <div class="pc-head">
      <div><div class="pc-title">${esc(p.title)}</div>${p.detail ? `<div class="pc-detail">${esc(p.detail)}</div>` : ""}</div>
      ${opt.manage ? `<div class="pc-actions">
        <button class="btn btn-sm" data-act="edit-practice" data-pid="${p.id}">수정</button>
        <button class="btn btn-sm btn-danger" data-act="del-practice" data-pid="${p.id}">삭제</button></div>` : ""}
    </div>
    ${showToday ? `<div class="today-row"><span class="today-label">오늘 ${mdw(t)}</span>
      ${["O", "T", "X"].map((k) => `<button class="mark-btn ${cur === k ? "on-" + k : ""}" data-act="mark" data-pid="${p.id}" data-mark="${k}">${MARKS[k]}</button>`).join("")}
      <span class="today-note">${cur ? "기록했어요! 다시 누르면 지워져요" : "오늘 실천했나요?"}</span></div>`
      : `<div style="height:12px"></div>`}
    ${dayGridHtml(p, r, opt.editable)}
    ${rateHtml(st)}
    ${cheerChipsHtml(p.id)}
    ${opt.cheer ? cheerBoxHtml(p.id) : ""}
  </div>`;
}

// ---------- 학생 화면 ----------
function studentHtml() {
  if (!S.rounds.length) return `<div class="empty">아직 열린 실천 회차가 없어요.<br>선생님이 회차를 만들면 여기에 나타나요. 🌱</div>`;
  const tabs = `<div class="tabs">
    <button class="tab ${S.tab === "mine" ? "active" : ""}" data-act="tab" data-tab="mine">📒 나의 실천</button>
    <button class="tab ${S.tab === "board" ? "active" : ""}" data-act="tab" data-tab="board">🏫 우리 반 실천 게시판</button></div>`;
  return roundBarHtml() + tabs + (S.tab === "board" ? boardHtml() : mineHtml());
}

function mineHtml() {
  const r = currentRound();
  if (!r) return "";
  const mine = S.practices.filter((p) => p.sid === S.sid);
  const max = r.maxItems || 3;
  const open = isOpen(r);
  const canWrite = open && r.allowEdit !== false;
  const addBtn = canWrite
    ? `<button class="btn btn-primary btn-sm" data-act="open-practice-form">✏️ 실천 다짐 ${mine.length ? "고치기" : "쓰기"} (${mine.length}/${max})</button>`
    : open ? `<span class="muted">선생님이 정해 준 실천이에요</span>` : "";
  const hasPreset = (r.presets || []).length > 0;
  const list = mine.length
    ? `<div class="practice-list">${mine.map((p) => practiceCardHtml(p, r, { editable: open })).join("")}</div>`
    : `<div class="empty">${canWrite
        ? `[실천 다짐 쓰기]를 눌러 이번 회차에 실천할 일을 적어 보세요!<br>${hasPreset ? "선생님이 적어 둔 실천을 그대로 쓰거나 바꿀 수 있어요." : "예) 하루에 한 번 친구에게 고맙다고 말하기"}`
        : open ? "실천 항목을 준비하고 있어요…" : "이 회차에 등록한 실천이 없어요."}</div>`;
  return `<div class="section-title"><span>나의 실천 다짐</span>${addBtn}</div>${list}
    ${!open ? `<p class="muted" style="margin-top:12px">종료된 회차는 기록을 볼 수만 있어요.</p>` : ""}`;
}

function boardHtml() {
  const r = currentRound();
  if (!r) return "";
  const t = today();
  const cards = S.students.filter((s) => s.active !== false).map((s) => {
    const ps = S.practices.filter((p) => p.sid === s.id);
    const cheerN = S.cheers.filter((c) => c.toSid === s.id).length;
    const items = ps.length ? ps.map((p) => {
      const st = practiceStats(p, r);
      const m = (p.checks || {})[t];
      return `<div class="stu-item"><div class="t"><span>${esc(p.title)}</span>
        <span>${m ? `<span class="mk m-${m}">${MARKS[m]}</span>` : ""}${st.rate == null ? "" : st.rate + "%"}</span></div>
        <div class="bar"><span style="width:${st.rate || 0}%"></span></div></div>`;
    }).join("") : `<div class="stu-none">아직 등록한 실천이 없어요</div>`;
    return `<div class="stu-card ${s.id === S.sid ? "me" : ""}" data-act="open-student" data-sid="${s.id}">
      <div class="stu-name"><span><span class="stu-num">${s.num}번</span>${esc(s.name)}</span>
        ${cheerN ? `<span class="cheer-count">💌 ${cheerN}</span>` : ""}</div>${items}</div>`;
  }).join("");
  return `<div class="section-title"><span>친구들의 실천</span><span class="muted">카드를 눌러 응원을 남겨 보세요</span></div>
    <div class="board">${cards}</div>`;
}

// ---------- 교사 화면 ----------
function teacherHtml() {
  const tabs = `<div class="tabs">
    <button class="tab ${S.tab === "status" ? "active" : ""}" data-act="tab" data-tab="status">📊 실천 현황</button>
    <button class="tab ${S.tab === "rounds" ? "active" : ""}" data-act="tab" data-tab="rounds">🗓️ 회차 관리</button>
    <button class="tab ${S.tab === "students" ? "active" : ""}" data-act="tab" data-tab="students">👥 학생 관리</button></div>`;
  let body = "";
  if (S.tab === "rounds") body = roundsAdminHtml();
  else if (S.tab === "students") body = studentsAdminHtml();
  else body = statusHtml();
  return tabs + body;
}

function statusHtml() {
  if (!S.rounds.length) return `<div class="empty">먼저 [회차 관리]에서 실천 회차를 만들어 주세요.</div>`;
  const r = currentRound();
  if (!r) return roundBarHtml();
  const t = today();
  const active = S.students.filter((s) => s.active !== false);
  const rows = active.map((s) => {
    const ps = S.practices.filter((p) => p.sid === s.id);
    const stats = ps.map((p) => practiceStats(p, r));
    const rates = stats.filter((x) => x.rate != null).map((x) => x.rate);
    const avg = rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : null;
    return { s, ps, avg, todayDone: ps.length && ps.every((p) => (p.checks || {})[t]),
      got: S.cheers.filter((c) => c.toSid === s.id).length,
      sent: S.cheers.filter((c) => c.fromSid === s.id).length };
  });
  const joined = rows.filter((x) => x.ps.length).length;
  const avgs = rows.filter((x) => x.avg != null).map((x) => x.avg);
  const classAvg = avgs.length ? Math.round(avgs.reduce((a, b) => a + b, 0) / avgs.length) : null;
  const todayN = rows.filter((x) => x.todayDone).length;

  const tr = rows.map(({ s, ps, avg, got, sent }) => `<tr class="clickrow" data-act="open-student" data-sid="${s.id}">
    <td class="num">${s.num}</td><td><b>${esc(s.name)}</b></td>
    <td>${ps.length ? ps.map((p) => { const m = (p.checks || {})[t];
      return `<div><span class="mk ${m ? "m-" + m : ""}">${m ? MARKS[m] : "·"}</span>${esc(p.title)}</div>`; }).join("") : `<span class="muted">미등록</span>`}</td>
    <td style="white-space:nowrap">${avg == null ? "-" : `<span class="bar mini-bar"><span style="width:${avg}%"></span></span>${avg}%`}</td>
    <td class="num">${got}</td><td class="num">${sent}</td></tr>`).join("");

  return roundBarHtml() + `
    <div class="stat-row">
      <div class="stat"><div class="k">실천 등록 학생</div><div class="v">${joined} / ${active.length}</div></div>
      <div class="stat"><div class="k">등록된 실천 항목</div><div class="v">${S.practices.length}</div></div>
      <div class="stat"><div class="k">학급 평균 실천률</div><div class="v">${classAvg == null ? "-" : classAvg + "%"}</div></div>
      <div class="stat"><div class="k">오늘 모두 기록한 학생</div><div class="v">${todayN}</div></div>
      <div class="stat"><div class="k">주고받은 응원</div><div class="v">${S.cheers.length}</div></div>
    </div>
    <div class="toolbar"><span class="muted">학생 줄을 누르면 자세히 보고, 기록을 고치거나 대신 등록할 수 있어요. (오늘 ${mdw(t)} 기준)</span>
      <span class="spacer"></span><button class="btn btn-sm" data-act="csv">⬇️ CSV 내려받기</button></div>
    <div class="table-wrap"><table class="tbl"><thead><tr>
      <th>번호</th><th>이름</th><th>실천 항목 (오늘)</th><th>실천률</th><th>받은 응원</th><th>보낸 응원</th>
    </tr></thead><tbody>${tr || `<tr><td colspan="6" class="muted">학생 명단이 없어요.</td></tr>`}</tbody></table></div>`;
}

function roundsAdminHtml() {
  const items = S.rounds.map((r) => `<div class="round-item">
    <div><div class="ri-title">${esc(r.title)} ${roundBadge(r)}</div>
      <div class="ri-sub">${mdw(r.start)} ~ ${mdw(r.end)} · ${roundDays(r).length}일${r.weekends === false ? " (주말 제외)" : ""} · 1인 최대 ${r.maxItems || 3}개${(r.presets || []).length ? ` · 교사 지정 ${r.presets.length}개` : ""}${r.allowEdit === false ? " · 학생 수정 불가" : ""}</div></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn btn-sm" data-act="edit-round" data-rid="${r.id}">수정</button>
      <button class="btn btn-sm" data-act="toggle-round" data-rid="${r.id}">${r.status === "open" ? "종료하기" : "다시 열기"}</button>
      <button class="btn btn-sm btn-danger" data-act="del-round" data-rid="${r.id}">삭제</button>
    </div></div>`).join("");
  return `<div class="section-title"><span>실천 회차</span><button class="btn btn-primary btn-sm" data-act="new-round">＋ 새 회차 만들기</button></div>
    <p class="muted" style="margin-top:-4px">여러 회차를 동시에 진행할 수 있어요. 종료한 회차는 학생들이 보기만 할 수 있어요.</p>
    ${items ? `<div class="round-list">${items}</div>` : `<div class="empty">아직 회차가 없어요. 첫 회차를 만들어 보세요.</div>`}`;
}

function studentsAdminHtml() {
  const rows = S.students.map((s) => `<tr>
    <td class="num">${s.num}</td>
    <td><input class="inline" id="nm-${s.id}" value="${esc(s.name)}" data-fresh="1">
      <button class="btn btn-sm" data-act="save-name" data-sid="${s.id}">저장</button></td>
    <td class="pin-cell">${S.showPins ? esc(S.pins[s.id] ?? "없음") : "••••"}</td>
    <td><button class="btn btn-sm" data-act="reset-pin" data-sid="${s.id}">비밀번호 초기화</button>
      <button class="btn btn-sm btn-danger" data-act="del-student" data-sid="${s.id}">삭제</button></td></tr>`).join("");
  return `<div class="section-title"><span>학생 명단 등록</span></div>
    <div class="practice-card" style="margin-bottom:18px">
      <div class="field"><label>한 줄에 한 명씩 "번호 이름" 으로 입력 (엑셀에서 두 칸 복사해 붙여 넣어도 돼요)</label>
        <textarea id="bulkText" rows="5" placeholder="1 김하늘&#10;2 이바다&#10;3 박나무"></textarea>
        <div class="hint">새 학생의 비밀번호는 <b>${esc(PIN_PREFIX)} + 번호 두 자리</b>로 만들어져요 (예: 1번 → ${pinFor(1)}, 15번 → ${pinFor(15)}). 이미 있는 번호는 이름만 바뀝니다.</div></div>
      <button class="btn btn-primary" data-act="bulk-add">명단 등록</button>
    </div>
    <div class="section-title"><span>학생 목록 (${S.students.length}명)</span>
      <span style="display:flex;gap:6px">
        <button class="btn btn-sm" data-act="toggle-pins">${S.showPins ? "🙈 비밀번호 숨기기" : "👁 비밀번호 보기"}</button>
        <button class="btn btn-sm" data-act="print-pins">🖨 비밀번호 쪽지 인쇄</button>
        <button class="btn btn-sm btn-danger" data-act="reset-all-pins">🔄 전체 비밀번호 초기화</button></span></div>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>번호</th><th>이름</th><th>비밀번호</th><th>관리</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="muted">아직 학생이 없어요.</td></tr>`}</tbody></table></div>`;
}

// ---------- 모달 ----------
function renderModal() {
  const root = $("#modalRoot");
  const m = S.modal;
  if (!m) { root.innerHTML = ""; return; }
  preserve(root, () => {
    let inner = "";
    if (m.type === "student") inner = studentModalHtml(m);
    else if (m.type === "practice") inner = practiceFormHtml(m);
    else if (m.type === "round") inner = roundFormHtml(m);
    else if (m.type === "pin") inner = pinFormHtml();
    root.innerHTML = `<div class="modal-back" data-act="modal-back">${inner}</div>`;
  });
  if (m.focus) { const el = document.getElementById(m.focus); if (el) el.focus(); m.focus = null; }
}

function modalHead(title) {
  return `<div class="modal-head"><h3>${title}</h3><button class="modal-close" data-act="close-modal">×</button></div>`;
}

function studentModalHtml(m) {
  const r = currentRound();
  const s = S.students.find((x) => x.id === m.sid);
  if (!r || !s) { S.modal = null; return ""; }
  const ps = S.practices.filter((p) => p.sid === s.id);
  const teacher = S.role === "teacher";
  const me = s.id === S.sid;
  const body = ps.length ? ps.map((p) => practiceCardHtml(p, r, {
    editable: teacher || (me && isOpen(r)), manage: teacher,
    cheer: !teacher && !me && isOpen(r),
  })).join("") : `<div class="empty">아직 등록한 실천이 없어요.</div>`;
  return `<div class="modal">${modalHead(`${s.num}번 ${esc(s.name)}의 실천`)}
    <div class="practice-list">${body}</div>
    ${teacher ? `<div class="modal-foot"><button class="btn btn-sm" data-act="open-practice-form" data-sid="${s.id}">✏️ 실천 다짐 고치기 / 대신 등록</button></div>` : ""}
  </div>`;
}

function openPracticeForm(sid) {
  const r = currentRound();
  if (!r) return;
  const mine = S.practices.filter((p) => p.sid === sid);
  const max = Math.max(r.maxItems || 3, mine.length);
  const slots = mine.map((p) => ({ pid: p.id, title: p.title, detail: p.detail || "", days: Object.keys(p.checks || {}).length }));
  if (!mine.length) (r.presets || []).forEach((t) => slots.push({ title: t, detail: "" }));
  while (slots.length < max) slots.push({ title: "", detail: "" });
  openModal({ type: "practice", sid, slots, back: S.modal?.type === "student" ? S.modal : null, focus: "pf-t-0" });
}

function practiceFormHtml(m) {
  const r = currentRound();
  const s = S.students.find((x) => x.id === m.sid);
  const teacher = S.role === "teacher";
  const rows = m.slots.map((sl, i) => `<div class="slot">
      <span class="slot-no">${i + 1}</span>
      <div class="slot-body">
        <input id="pf-t-${i}" maxlength="40" value="${esc(sl.title)}" placeholder="${i === 0 ? "예) 친구에게 하루 한 번 칭찬하기" : "실천할 일 (비워 두면 등록 안 함)"}">
        <input id="pf-d-${i}" class="slot-detail" maxlength="200" value="${esc(sl.detail)}" placeholder="(선택) 어떻게, 왜 실천할까요?">
        ${sl.days ? `<div class="hint">이미 ${sl.days}일 기록했어요. 칸을 비우면 기록도 함께 지워져요.</div>` : ""}
      </div></div>`).join("");
  return `<div class="modal narrow">${modalHead(`${teacher && s ? `${s.num}번 ${esc(s.name)} — ` : ""}실천 다짐 쓰기`)}
    <p class="muted" style="margin:-6px 0 12px">최대 ${m.slots.length}개까지 한 번에 적고 [저장]을 누르세요. 필요 없는 칸은 비워 두면 돼요.</p>
    <div class="slot-list">${rows}</div>
    <div class="err" id="pfErr"></div>
    <div class="modal-foot"><button class="btn" data-act="close-modal">취소</button>
      <button class="btn btn-primary" data-act="save-practice">저장</button></div></div>`;
}

function roundFormHtml(m) {
  const r = m.rid ? S.rounds.find((x) => x.id === m.rid) : null;
  const t = today();
  const end = fmt(new Date(Date.now() + 13 * 86400000));
  return `<div class="modal narrow">${modalHead(r ? "회차 수정" : "새 실천 회차")}
    <div class="field"><label>회차 이름</label><input id="rfTitle" maxlength="40" value="${esc(r?.title || "")}" placeholder="예) 1차 배려 실천 주간"></div>
    <div class="field"><label>안내 문구 (학생 화면 위쪽에 보여요)</label>
      <textarea id="rfDesc" maxlength="500" placeholder="예) '배려' 단원을 배우고, 생활 속에서 실천할 일을 2가지 정해 보세요.">${esc(r?.desc || "")}</textarea></div>
    <div class="row2">
      <div class="field"><label>시작일</label><input id="rfStart" type="date" value="${r?.start || t}"></div>
      <div class="field"><label>종료일</label><input id="rfEnd" type="date" value="${r?.end || end}"></div>
    </div>
    <div class="row2">
      <div class="field"><label>1인당 최대 실천 개수</label><select id="rfMax">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<option ${(r?.maxItems || 3) === n ? "selected" : ""}>${n}</option>`).join("")}</select></div>
      <div class="field"><label>&nbsp;</label><label class="check-line"><input id="rfWeekend" type="checkbox" ${r?.weekends === false ? "" : "checked"}> 주말도 기록하기</label></div>
    </div>
    <div class="field"><label>교사가 정해 주는 실천 (선택 · 한 줄에 하나씩)</label>
      <textarea id="rfPresets" rows="3" placeholder="예) 친구에게 먼저 인사하기&#10;급식 남기지 않기">${esc((r?.presets || []).join("\n"))}</textarea>
      <div class="hint">비워 두면 학생이 처음부터 직접 적어요. 적어 두면 학생 입력 칸에 미리 채워져요.</div></div>
    <label class="check-line" style="margin-bottom:6px"><input id="rfAllowEdit" type="checkbox" ${r?.allowEdit === false ? "" : "checked"}> 학생이 실천 내용을 바꾸거나 더 추가할 수 있어요</label>
    <div class="hint" style="margin-bottom:8px">체크를 끄면 위에 적은 실천이 모든 학생에게 그대로 등록되고, 학생은 O/△/X 기록만 해요.</div>
    <div class="err" id="rfErr"></div>
    <div class="modal-foot"><button class="btn" data-act="close-modal">취소</button>
      <button class="btn btn-primary" data-act="save-round">저장</button></div></div>`;
}

function pinFormHtml() {
  return `<div class="modal narrow">${modalHead("비밀번호 변경")}
    <div class="field"><label>지금 비밀번호</label><input id="pinOld" class="pin-input" type="password" inputmode="numeric" maxlength="4"></div>
    <div class="field"><label>새 비밀번호 (숫자 4자리)</label><input id="pinNew" class="pin-input" type="password" inputmode="numeric" maxlength="4"></div>
    <div class="field"><label>새 비밀번호 한 번 더</label><input id="pinNew2" class="pin-input" type="password" inputmode="numeric" maxlength="4" data-enter="save-pin"></div>
    <div class="err" id="pinErr"></div>
    <div class="modal-foot"><button class="btn" data-act="close-modal">취소</button>
      <button class="btn btn-primary" data-act="save-pin">바꾸기</button></div></div>`;
}

function openModal(m) { S.modal = m; renderModal(); }
function closeModal() { S.modal = null; renderModal(); }

// ============================================================
//  동작
// ============================================================
async function setMark(pid, date, mark) {
  const p = S.practices.find((x) => x.id === pid);
  if (!p) return;
  const cur = (p.checks || {})[date];
  const next = cur === mark ? null : mark;
  try {
    await updateDoc(doc(db, "practices", pid), {
      [`checks.${date}`]: next ? next : deleteField(),
      updatedAt: serverTimestamp(),
    });
  } catch (e) { toast(errMsg(e)); }
}

async function cycleMark(pid, date) {
  const p = S.practices.find((x) => x.id === pid);
  if (!p) return;
  const order = [undefined, "O", "T", "X"];
  const cur = (p.checks || {})[date];
  const next = order[(order.indexOf(cur) + 1) % order.length];
  try {
    await updateDoc(doc(db, "practices", pid), {
      [`checks.${date}`]: next ? next : deleteField(),
      updatedAt: serverTimestamp(),
    });
  } catch (e) { toast(errMsg(e)); }
}

async function savePractice() {
  const m = S.modal;
  const r = currentRound();
  const err = $("#pfErr");
  const rows = m.slots.map((sl, i) => ({
    ...sl, i,
    nt: (document.getElementById(`pf-t-${i}`)?.value || "").trim(),
    nd: (document.getElementById(`pf-d-${i}`)?.value || "").trim(),
  }));
  const dels = rows.filter((x) => x.pid && !x.nt);
  const recorded = dels.filter((x) => x.days);
  if (recorded.length && !confirm(`비운 칸 중 ${recorded.length}개는 이미 기록이 있어요.\n지우면 기록과 받은 응원도 사라져요. 계속할까요?`)) return;
  err.textContent = "저장 중…";
  try {
    const b = writeBatch(db);
    let n = 0;
    rows.forEach((x) => {
      if (x.pid && !x.nt) { b.delete(doc(db, "practices", x.pid)); n++; }
      else if (x.pid && (x.nt !== x.title || x.nd !== x.detail)) {
        b.update(doc(db, "practices", x.pid), { title: x.nt, detail: x.nd, updatedAt: serverTimestamp() }); n++;
      } else if (!x.pid && x.nt) {
        b.set(doc(collection(db, "practices")), {
          rid: r.id, sid: m.sid, title: x.nt, detail: x.nd, checks: {}, order: x.i,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        }); n++;
      }
    });
    if (S.role === "teacher") dels.forEach((x) => S.cheers.filter((c) => c.pid === x.pid).forEach((c) => b.delete(doc(db, "cheers", c.id))));
    if (n) await b.commit();
    toast(n ? "실천 다짐을 저장했어요! 🌱" : "바뀐 내용이 없어요.");
    S.modal = m.back || null;
    renderModal();
  } catch (e) { err.textContent = errMsg(e); }
}

// 교사가 '학생 수정 불가'로 정한 회차: 교사 지정 실천을 학생 기록장에 자동 등록
async function autoCreatePresets() {
  const r = currentRound();
  if (!r || !isOpen(r) || r.allowEdit !== false || !(r.presets || []).length) return;
  if (S.practices.some((p) => p.sid === S.sid) || S.autoDone[r.id]) return;
  S.autoDone[r.id] = true;
  try {
    const b = writeBatch(db);
    r.presets.forEach((t, i) => b.set(doc(db, "practices", `${r.id}_${S.sid}_${i}`), {
      rid: r.id, sid: S.sid, title: t, detail: "", checks: {}, order: i,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }));
    await b.commit();
  } catch (e) { console.warn(e); S.autoDone[r.id] = false; }
}

async function delPractice(pid) {
  const p = S.practices.find((x) => x.id === pid);
  if (!p) return;
  const n = Object.keys(p.checks || {}).length;
  if (!confirm(`'${p.title}' 실천을 지울까요?${n ? `\n기록한 ${n}일의 체크와 받은 응원도 함께 사라져요.` : ""}`)) return;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, "practices", pid));
    // 학생은 남이 보낸 응원을 지울 권한이 없으므로 교사일 때만 함께 정리
    if (S.role === "teacher") S.cheers.filter((c) => c.pid === pid).forEach((c) => batch.delete(doc(db, "cheers", c.id)));
    await batch.commit();
    toast("지웠어요.");
  } catch (e) { toast(errMsg(e)); }
}

async function sendCheer(pid) {
  const p = S.practices.find((x) => x.id === pid);
  if (!p) return;
  const input = document.getElementById(`cheer-${pid}`);
  const text = (input?.value || "").trim().slice(0, 60);
  const emoji = S.modal?.emoji?.[pid] || EMOJIS[0];
  try {
    await addDoc(collection(db, "cheers"), {
      pid, rid: p.rid, toSid: p.sid, fromSid: S.sid, emoji, text, createdAt: serverTimestamp(),
    });
    if (input) input.value = "";
    toast("응원을 보냈어요! 💌");
  } catch (e) { toast(errMsg(e)); }
}

async function delCheer(cid) {
  if (!confirm("이 응원을 지울까요?")) return;
  try { await deleteDoc(doc(db, "cheers", cid)); } catch (e) { toast(errMsg(e)); }
}

async function savePin() {
  const o = $("#pinOld").value.trim(), n = $("#pinNew").value.trim(), n2 = $("#pinNew2").value.trim();
  const err = $("#pinErr");
  if (!/^\d{4}$/.test(n)) { err.textContent = "새 비밀번호는 숫자 4자리예요."; return; }
  if (n !== n2) { err.textContent = "새 비밀번호가 서로 달라요."; return; }
  const ses = doc(db, "sessions", auth.currentUser.uid);
  try {
    // 지금 비밀번호가 맞는지 세션을 다시 써 보며 확인 (틀리면 규칙에서 거절됨)
    await setDoc(ses, { sid: S.sid, pin: o, at: serverTimestamp() });
  } catch (e) { err.textContent = "지금 비밀번호가 맞지 않아요."; return; }
  try {
    await setDoc(doc(db, "pins", S.sid), { pin: n, updatedAt: serverTimestamp() });
    await setDoc(ses, { sid: S.sid, pin: n, at: serverTimestamp() });
    closeModal();
    toast("비밀번호를 바꿨어요.");
  } catch (e) { err.textContent = errMsg(e); }
}

async function saveRound() {
  const m = S.modal;
  const title = $("#rfTitle").value.trim();
  const desc = $("#rfDesc").value.trim();
  const start = $("#rfStart").value, end = $("#rfEnd").value;
  const maxItems = Number($("#rfMax").value);
  const weekends = $("#rfWeekend").checked;
  const presets = $("#rfPresets").value.split("\n").map((x) => x.trim()).filter(Boolean);
  const allowEdit = $("#rfAllowEdit").checked;
  const err = $("#rfErr");
  if (!title) { err.textContent = "회차 이름을 적어 주세요."; return; }
  if (!start || !end || start > end) { err.textContent = "기간을 확인해 주세요."; return; }
  if (presets.some((x) => x.length > 40)) { err.textContent = "교사 지정 실천은 한 줄에 40자까지예요."; return; }
  if (presets.length > maxItems) { err.textContent = `교사 지정 실천(${presets.length}개)이 최대 개수(${maxItems}개)보다 많아요.`; return; }
  if (!allowEdit && !presets.length) { err.textContent = "학생 수정을 막으려면 교사 지정 실천을 1개 이상 적어 주세요."; return; }
  const data = { title, desc, start, end, maxItems, weekends, presets, allowEdit };
  try {
    if (m.rid) await updateDoc(doc(db, "rounds", m.rid), data);
    else {
      const ref = await addDoc(collection(db, "rounds"), { ...data, status: "open", createdAt: serverTimestamp() });
      selectRound(ref.id, true);
    }
    closeModal();
    toast("저장했어요.");
  } catch (e) { err.textContent = errMsg(e); }
}

async function toggleRound(rid) {
  const r = S.rounds.find((x) => x.id === rid);
  const next = r.status === "open" ? "closed" : "open";
  if (next === "closed" && !confirm(`'${r.title}' 회차를 종료할까요?\n학생들은 기록을 볼 수만 있게 됩니다.`)) return;
  try { await updateDoc(doc(db, "rounds", rid), { status: next }); toast(next === "open" ? "다시 열었어요." : "종료했어요."); }
  catch (e) { toast(errMsg(e)); }
}

async function delRound(rid) {
  const r = S.rounds.find((x) => x.id === rid);
  if (!confirm(`'${r.title}' 회차를 완전히 삭제할까요?\n이 회차의 실천 기록과 응원이 모두 사라지고 되돌릴 수 없어요.`)) return;
  if (prompt("삭제하려면 회차 이름을 똑같이 입력하세요.") !== r.title) { toast("이름이 달라서 취소했어요."); return; }
  try {
    const [ps, cs] = await Promise.all([
      getDocs(query(collection(db, "practices"), where("rid", "==", rid))),
      getDocs(query(collection(db, "cheers"), where("rid", "==", rid))),
    ]);
    const refs = [...ps.docs, ...cs.docs].map((d) => d.ref);
    refs.push(doc(db, "rounds", rid));
    for (let i = 0; i < refs.length; i += 400) {
      const b = writeBatch(db);
      refs.slice(i, i + 400).forEach((ref) => b.delete(ref));
      await b.commit();
    }
    toast("삭제했어요.");
  } catch (e) { toast(errMsg(e)); }
}

async function bulkAdd() {
  const lines = $("#bulkText").value.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const parsed = [], bad = [];
  lines.forEach((l) => {
    const m = l.match(/^(\d{1,2})\s*(?:번)?[\s,\t]+(.+)$/);
    if (m && Number(m[1]) > 0) parsed.push({ num: Number(m[1]), name: m[2].trim() });
    else bad.push(l);
  });
  if (!parsed.length) { toast("입력 형식을 확인해 주세요. 예) 1 김하늘"); return; }
  try {
    const b = writeBatch(db);
    let added = 0, renamed = 0;
    parsed.forEach(({ num, name }) => {
      const sid = sidOf(num);
      const exists = S.students.find((s) => s.id === sid);
      b.set(doc(db, "students", sid), { num, name, active: true }, { merge: true });
      if (!exists || !S.pins[sid]) { b.set(doc(db, "pins", sid), { pin: pinFor(num), updatedAt: serverTimestamp() }); added++; }
      else renamed++;
    });
    await b.commit();
    $("#bulkText").value = "";
    toast(`새 학생 ${added}명, 이름 수정 ${renamed}명${bad.length ? ` · 인식 못 한 줄 ${bad.length}개` : ""}`, 3500);
  } catch (e) { toast(errMsg(e)); }
}

async function saveName(sid) {
  const name = document.getElementById(`nm-${sid}`).value.trim();
  if (!name) return;
  try { await updateDoc(doc(db, "students", sid), { name }); toast("이름을 저장했어요."); }
  catch (e) { toast(errMsg(e)); }
}

async function resetPin(sid) {
  const s = S.students.find((x) => x.id === sid);
  const pin = pinFor(s.num);
  if (!confirm(`${s.num}번 ${s.name} 학생의 비밀번호를 ${pin}(으)로 초기화할까요?`)) return;
  try {
    await setDoc(doc(db, "pins", sid), { pin, updatedAt: serverTimestamp() });
    alert(`${s.num}번 ${s.name}\n새 비밀번호: ${pin}`);
  } catch (e) { toast(errMsg(e)); }
}

async function resetAllPins() {
  if (!S.students.length) return;
  const ex = S.students[0];
  if (!confirm(`우리 반 학생 ${S.students.length}명의 비밀번호를 모두 초기화할까요?\n규칙: ${PIN_PREFIX} + 번호 두 자리 (예: ${ex.num}번 → ${pinFor(ex.num)})\n학생이 바꾼 비밀번호도 모두 이 규칙으로 돌아가요.`)) return;
  try {
    const b = writeBatch(db);
    S.students.forEach((s) => b.set(doc(db, "pins", s.id), { pin: pinFor(s.num), updatedAt: serverTimestamp() }));
    await b.commit();
    toast(`${S.students.length}명의 비밀번호를 초기화했어요.`, 3000);
  } catch (e) { toast(errMsg(e)); }
}

async function delStudent(sid) {
  const s = S.students.find((x) => x.id === sid);
  if (!confirm(`${s.num}번 ${s.name} 학생을 명단에서 삭제할까요?\n(그동안의 실천 기록은 남지만 화면에 보이지 않아요)`)) return;
  try {
    const b = writeBatch(db);
    b.delete(doc(db, "students", sid));
    b.delete(doc(db, "pins", sid));
    await b.commit();
  } catch (e) { toast(errMsg(e)); }
}

function printPins() {
  const w = window.open("", "_blank");
  if (!w) { toast("팝업이 막혀 있어요."); return; }
  const cells = S.students.map((s) => `<div class="c"><b>${s.num}번 ${esc(s.name)}</b><span>비밀번호 <i>${esc(S.pins[s.id] || "-")}</i></span></div>`).join("");
  w.document.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>비밀번호 쪽지</title>
    <style>body{font-family:'Noto Sans KR',sans-serif;margin:16px}.g{display:grid;grid-template-columns:repeat(3,1fr);gap:0}
    .c{border:1px dashed #999;padding:14px;display:flex;flex-direction:column;gap:6px;font-size:15px}
    i{font-style:normal;font-family:monospace;font-size:20px;letter-spacing:3px}h3{margin:0 0 10px}</style></head>
    <body><h3>도덕 실천 기록장 — ${esc(CLASS_NAME)} 비밀번호 (주소: ${esc(location.origin + location.pathname)})</h3>
    <div class="g">${cells}</div><script>print()<\/script></body></html>`);
  w.document.close();
}

function downloadCsv() {
  const r = currentRound();
  if (!r) return;
  const days = roundDays(r);
  const head = ["번호", "이름", "실천 항목", "다짐", "O", "△", "X", "미기록", "실천률(%)", "받은 응원", ...days.map(md)];
  const rows = [head];
  S.students.forEach((s) => {
    const ps = S.practices.filter((p) => p.sid === s.id);
    if (!ps.length) rows.push([s.num, s.name, "(미등록)"]);
    ps.forEach((p) => {
      const st = practiceStats(p, r);
      rows.push([s.num, s.name, p.title, p.detail || "", st.O, st.T, st.X, st.none, st.rate ?? "",
        S.cheers.filter((c) => c.pid === p.id).length,
        ...days.map((d) => MARKS[(p.checks || {})[d]] || "")]);
    });
  });
  const csv = rows.map((row) => row.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `실천기록_${r.title}_${today()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- 이벤트 위임 ----------
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const a = el.dataset.act, d = el.dataset;
  if (a === "modal-back") { if (e.target === el) closeModal(); return; }
  switch (a) {
    case "login-mode": S.loginMode = d.mode; render(); break;
    case "student-login": studentLogin(); break;
    case "teacher-login": teacherLogin(); break;
    case "logout": logout(); break;
    case "tab": S.tab = d.tab; render(); break;
    case "mark": setMark(d.pid, today(), d.mark); break;
    case "cycle": cycleMark(d.pid, d.date); break;
    case "open-practice-form": openPracticeForm(d.sid || S.sid); break;
    case "edit-practice": openPracticeForm(S.practices.find((p) => p.id === d.pid)?.sid); break;
    case "save-practice": savePractice(); break;
    case "del-practice": delPractice(d.pid); break;
    case "open-student": openModal({ type: "student", sid: d.sid, emoji: {} }); break;
    case "pick-emoji": S.modal.emoji[d.pid] = d.emoji; renderModal(); break;
    case "send-cheer": sendCheer(d.pid); break;
    case "del-cheer": delCheer(d.cid); break;
    case "close-modal": S.modal = S.modal?.back || null; renderModal(); break;
    case "open-pin": openModal({ type: "pin", focus: "pinOld" }); break;
    case "save-pin": savePin(); break;
    case "new-round": openModal({ type: "round", focus: "rfTitle" }); break;
    case "edit-round": openModal({ type: "round", rid: d.rid }); break;
    case "save-round": saveRound(); break;
    case "toggle-round": toggleRound(d.rid); break;
    case "del-round": delRound(d.rid); break;
    case "bulk-add": bulkAdd(); break;
    case "save-name": saveName(d.sid); break;
    case "reset-pin": resetPin(d.sid); break;
    case "reset-all-pins": resetAllPins(); break;
    case "del-student": delStudent(d.sid); break;
    case "toggle-pins": S.showPins = !S.showPins; render(); break;
    case "print-pins": printPins(); break;
    case "csv": downloadCsv(); break;
  }
});

document.addEventListener("change", (e) => {
  if (e.target.dataset.change === "round") selectRound(e.target.value);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && S.modal) { closeModal(); return; }
  if (e.key !== "Enter" || e.isComposing) return;
  const act = e.target.dataset?.enter;
  if (!act) return;
  e.preventDefault();
  if (act === "student-login") studentLogin();
  else if (act === "teacher-login") teacherLogin();
  else if (act === "save-pin") savePin();
  else if (act === "send-cheer") sendCheer(e.target.dataset.pid);
});

// 상단 바 높이에 맞춰 메뉴 탭을 고정
const topbarEl = document.querySelector(".topbar");
if (topbarEl && "ResizeObserver" in window) {
  new ResizeObserver(() => document.documentElement.style.setProperty("--topbar-h", topbarEl.offsetHeight + "px")).observe(topbarEl);
}
