/* 减肥八法大作战 —— 射击运动图标，消灭鸡腿塔！ */
(() => {
'use strict';

// ---------- 常量 ----------
const W = 480, H = 720;
const CELL_W = 54, CELL_H = 46, LEG_R = 23, COLS = 8, GRID_TOP = 80;
const DANGER_Y = H - 165;                 // 红线高度，鸡腿压线即失败
const CANNON = { x: W / 2, y: H - 64 };   // 射击塔位置
const BULLET_R = 19, BULLET_SPEED = 740, COOLDOWN = 0.24;

// 运动六法（篮球带溅射燃脂效果）
const SPORTS = [
  { emoji: '🚶', name: '走路',   color: '#43a047' },
  { emoji: '🏊', name: '游泳',   color: '#1e88e5' },
  { emoji: '🪢', name: '跳绳',   color: '#8e24aa' },
  { emoji: '🏓', name: '乒乓球', color: '#f4511e' },
  { emoji: '🏀', name: '篮球',   color: '#fb8c00', splash: true },
  { emoji: '🏸', name: '羽毛球', color: '#00acc1' },
];
const EMOJI_FONT = `"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;

// ---------- 画布 ----------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
function resize() {
  const d = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = W * d;
  canvas.height = H * d;
  ctx.setTransform(d, 0, 0, d, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const hudLevel = $('hudLevel'), hudScore = $('hudScore'), hudLeft = $('hudLeft'),
      nextBubble = $('nextBubble'), toastEl = $('toast'),
      startScr = $('startScr'), overScr = $('overScr');

// ---------- 音效（WebAudio 合成，无外部资源） ----------
let AC = null;
function audio() {
  if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
  if (AC.state === 'suspended') AC.resume();
  return AC;
}
function tone(f0, f1, dur, type = 'sine', vol = 0.12, delay = 0) {
  try {
    const ac = audio(), t = ac.currentTime + delay;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(ac.destination);
    o.start(t); o.stop(t + dur + 0.02);
  } catch (e) { /* 无音频环境时静默 */ }
}
const sfx = {
  shoot:   () => tone(520, 180, 0.12, 'square', 0.06),
  hit:     () => tone(280, 120, 0.08, 'triangle', 0.12),
  crack:   () => tone(200, 90, 0.1, 'sawtooth', 0.1),
  destroy: () => { tone(620, 980, 0.1, 'sine', 0.14); tone(980, 1500, 0.09, 'sine', 0.1, 0.06); },
  levelup: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 0.14, 'sine', 0.12, i * 0.1)),
  over:    () => tone(320, 70, 0.6, 'sawtooth', 0.12),
};

// ---------- 游戏状态 ----------
let state = 'start';           // start | playing | gameover
let level = 1, score = 0;
let best = +(localStorage.getItem('lw_best') || 0);
let legs = [];                 // 鸡腿塔 {row,col,hp,maxHp,wob}
let bullets = [], particles = [], floats = [];
let gridOffsetY = 0, descentSpeed = 4;
let currentAmmo, nextAmmo;
let cooldownT = 0, aimAngle = -Math.PI / 2;
let pendingNext = false, nextTimer = 0;
let shake = 0, time = 0;
const keys = {};

const randSport = () => SPORTS[(Math.random() * SPORTS.length) | 0];

// ---------- 关卡 ----------
function buildLevel(lv) {
  legs = [];
  gridOffsetY = 0;
  const rows = Math.min(3 + lv, 8);                 // 第1关4行，最多8行
  const p2 = lv < 2 ? 0 : Math.min(0.08 * (lv - 1), 0.35); // 双层脆皮鸡腿概率
  for (let r = 0; r < rows; r++) {
    const n = r % 2 ? COLS - 1 : COLS;              // 奇数行错开半格
    for (let c = 0; c < n; c++) {
      const hp = Math.random() < p2 ? 2 : 1;
      legs.push({ row: r, col: c, hp, maxHp: hp, wob: Math.random() * Math.PI * 2 });
    }
  }
  descentSpeed = 3.4 + lv * 0.7;
}

function legPos(leg) {
  const stagger = leg.row % 2 ? CELL_W / 2 : 0;
  return {
    x: (W - COLS * CELL_W) / 2 + CELL_W / 2 + leg.col * CELL_W + stagger,
    y: GRID_TOP + leg.row * CELL_H + gridOffsetY,
  };
}

// ---------- 射击 ----------
function shoot() {
  if (state !== 'playing' || pendingNext || cooldownT > 0) return;
  cooldownT = COOLDOWN;
  bullets.push({
    x: CANNON.x + Math.cos(aimAngle) * 54,
    y: CANNON.y + Math.sin(aimAngle) * 54,
    vx: Math.cos(aimAngle) * BULLET_SPEED,
    vy: Math.sin(aimAngle) * BULLET_SPEED,
    sport: currentAmmo,
  });
  currentAmmo = nextAmmo;
  nextAmmo = randSport();
  nextBubble.textContent = nextAmmo.emoji;
  sfx.shoot();
}

function onHit(target, sport) {
  const tp = legPos(target);
  const destroyed = [];
  const damage = leg => { leg.hp--; if (leg.hp <= 0) destroyed.push(leg); };

  damage(target);
  if (sport.splash) {                       // 🏀 篮球：范围燃脂
    for (const l of legs) {
      if (l === target) continue;
      const p = legPos(l);
      if (Math.hypot(p.x - tp.x, p.y - tp.y) < CELL_W * 1.05) damage(l);
    }
    floats.push({ x: tp.x, y: tp.y - 30, text: '💥 燃脂爆发!', life: 1, color: '#ffb300' });
  }

  if (destroyed.length) {
    legs = legs.filter(l => !destroyed.includes(l));
    let gain = 0;
    for (const l of destroyed) {
      const p = legPos(l);
      gain += l.maxHp === 2 ? 120 : 50;
      burst(p.x, p.y, sport.color);
      floats.push({ x: p.x, y: p.y, text: `+${l.maxHp === 2 ? 120 : 50}`, life: 1, color: '#fff' });
    }
    if (destroyed.length >= 2) {            // 连消奖励
      gain += (destroyed.length - 1) * 30;
      floats.push({ x: tp.x, y: tp.y - 52, text: `🔥 ${destroyed.length}连消!`, life: 1.2, color: '#ffd54f' });
    }
    score += gain;
    shake = Math.min(9, shake + 3 + destroyed.length);
    sfx.destroy();
  } else {
    score += target.hp < target.maxHp ? 20 : 0;   // 打碎脆皮 +20
    burst(tp.x, tp.y, '#d7ccc8', 6);
    sfx.crack();
  }
}

function burst(x, y, color, n = 12) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 160;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, life: 0.6 + Math.random() * 0.3, color });
  }
}

// ---------- 更新 ----------
function update(dt) {
  time += dt;
  cooldownT = Math.max(0, cooldownT - dt);
  shake = Math.max(0, shake - 26 * dt);

  if (keys.ArrowLeft)  aimAngle = Math.max(-Math.PI + 0.26, aimAngle - 2.4 * dt);
  if (keys.ArrowRight) aimAngle = Math.min(-0.26, aimAngle + 2.4 * dt);

  // 粒子与飘字全状态更新
  for (const p of particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 300 * dt; p.life -= dt; }
  particles = particles.filter(p => p.life > 0);
  for (const f of floats) { f.y -= 46 * dt; f.life -= dt; }
  floats = floats.filter(f => f.life > 0);

  if (state !== 'playing') return;

  if (pendingNext) {                        // 过关间隙
    nextTimer -= dt;
    if (nextTimer <= 0) {
      pendingNext = false;
      level++;
      buildLevel(level);
      hudLevel.textContent = level;
      toast(`第 ${level} 关`);
    }
    return;
  }

  // 鸡腿塔下降
  gridOffsetY += descentSpeed * dt;

  // 子弹
  for (const b of bullets) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.x < BULLET_R)     { b.x = BULLET_R;     b.vx *= -1; }
    if (b.x > W - BULLET_R) { b.x = W - BULLET_R; b.vx *= -1; }

    for (const leg of legs) {
      const p = legPos(leg);
      if (Math.hypot(p.x - b.x, p.y - b.y) < BULLET_R + LEG_R - 4) {
        onHit(leg, b.sport);
        b.dead = true;
        break;
      }
    }
    if (b.y < -30) b.dead = true;
  }
  bullets = bullets.filter(b => !b.dead);

  // 失败判定
  for (const leg of legs) {
    if (legPos(leg).y + LEG_R > DANGER_Y) return gameOver();
  }

  // 过关判定
  if (!legs.length) {
    pendingNext = true;
    nextTimer = 1.6;
    const bonus = level * 150;
    score += bonus;
    toast(level === 8 ? `🎉 八法全通！奖励 ${bonus}` : `过关！奖励 ${bonus} kcal`);
    sfx.levelup();
  }

  hudScore.textContent = score;
  hudLeft.textContent = legs.length;
}

function gameOver() {
  state = 'gameover';
  best = Math.max(best, score);
  localStorage.setItem('lw_best', best);
  $('finalScore').textContent = score;
  $('bestScore').textContent = best;
  overScr.classList.add('show');
  sfx.over();
}

function startGame() {
  level = 1; score = 0;
  bullets = []; particles = []; floats = [];
  cooldownT = 0; aimAngle = -Math.PI / 2;
  pendingNext = false; shake = 0;
  currentAmmo = randSport(); nextAmmo = randSport();
  nextBubble.textContent = nextAmmo.emoji;
  hudLevel.textContent = 1;
  hudScore.textContent = 0;
  buildLevel(1);
  hudLeft.textContent = legs.length;
  state = 'playing';
  startScr.classList.remove('show');
  overScr.classList.remove('show');
}

let toastTimer;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove('show');
  void toastEl.offsetWidth;                 // 重触发动画
  toastEl.classList.add('show');
}

// ---------- 绘制 ----------
function draw() {
  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);

  // 背景
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#aee9ff');
  bg.addColorStop(0.6, '#e3f7e8');
  bg.addColorStop(1, '#fff3d6');
  ctx.fillStyle = bg;
  ctx.fillRect(-10, -10, W + 20, H + 20);

  drawDangerLine();
  drawLegs();
  if (state === 'playing' && !pendingNext) drawTrajectory();
  drawBullets();
  drawCannon();
  drawParticles();
  drawFloats();

  ctx.restore();
}

function drawDangerLine() {
  // 鸡腿接近红线时闪烁告警
  let minDist = Infinity;
  for (const leg of legs) minDist = Math.min(minDist, DANGER_Y - (legPos(leg).y + LEG_R));
  const warn = minDist < 90 && state === 'playing';
  ctx.save();
  ctx.strokeStyle = warn ? `rgba(229,57,53,${0.55 + 0.45 * Math.sin(time * 10)})` : 'rgba(229,57,53,.45)';
  ctx.lineWidth = warn ? 4 : 2;
  ctx.setLineDash([12, 8]);
  ctx.beginPath();
  ctx.moveTo(0, DANGER_Y);
  ctx.lineTo(W, DANGER_Y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `13px sans-serif`;
  ctx.fillStyle = 'rgba(198,40,40,.8)';
  ctx.textAlign = 'left';
  ctx.fillText('⚠️ 警戒线', 8, DANGER_Y - 6);
  ctx.restore();
}

function drawLegs() {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const leg of legs) {
    const p = legPos(leg);
    const rot = Math.sin(time * 2.6 + leg.wob) * 0.12;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(rot);

    // 泡泡底
    ctx.beginPath();
    ctx.arc(0, 0, LEG_R, 0, Math.PI * 2);
    ctx.fillStyle = leg.maxHp === 2 && leg.hp === 2 ? 'rgba(255,213,79,.92)' : 'rgba(255,255,255,.88)';
    ctx.fill();
    ctx.lineWidth = leg.maxHp === 2 ? 3 : 2;
    ctx.strokeStyle = leg.maxHp === 2 ? (leg.hp === 2 ? '#ff8f00' : '#bcaaa4') : 'rgba(0,0,0,.12)';
    ctx.stroke();

    ctx.font = `26px ${EMOJI_FONT}`;
    ctx.fillText('🍗', 0, 1);

    if (leg.maxHp === 2 && leg.hp === 2) {  // 双层脆皮标记
      ctx.font = `bold 10px sans-serif`;
      ctx.fillStyle = '#e65100';
      ctx.fillText('x2', LEG_R - 7, -LEG_R + 7);
    }
    ctx.restore();
  }
}

function drawTrajectory() {
  let x = CANNON.x + Math.cos(aimAngle) * 54,
      y = CANNON.y + Math.sin(aimAngle) * 54,
      vx = Math.cos(aimAngle), vy = Math.sin(aimAngle);
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,.28)';
  for (let i = 0; i < 56; i++) {
    x += vx * 10; y += vy * 10;
    if (x < BULLET_R)     { x = BULLET_R;     vx *= -1; }
    if (x > W - BULLET_R) { x = W - BULLET_R; vx *= -1; }
    if (y < 10) break;
    let near = false;
    for (const leg of legs) {
      const p = legPos(leg);
      if (Math.hypot(p.x - x, p.y - y) < BULLET_R + LEG_R) { near = true; break; }
    }
    if (near) break;
    if (i % 2 === 0) {
      ctx.globalAlpha = 1 - i / 60;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawBullets() {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const b of bullets) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, BULLET_R, 0, Math.PI * 2);
    ctx.fillStyle = b.sport.color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.stroke();
    ctx.font = `20px ${EMOJI_FONT}`;
    ctx.fillText(b.sport.emoji, b.x, b.y + 1);
  }
}

function drawCannon() {
  const { x, y } = CANNON;

  // 瞄准炮管
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(aimAngle + Math.PI / 2);
  ctx.fillStyle = '#546e7a';
  roundRect(-8, -52, 16, 44, 7);
  ctx.fill();
  ctx.restore();

  // 塔身
  const grad = ctx.createLinearGradient(x - 30, y, x + 30, y);
  grad.addColorStop(0, '#78909c');
  grad.addColorStop(0.5, '#b0bec5');
  grad.addColorStop(1, '#78909c');
  ctx.fillStyle = grad;
  roundRect(x - 26, y - 8, 52, 58, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.2)';
  ctx.stroke();

  // 当前弹药泡泡
  ctx.beginPath();
  ctx.arc(x, y - 14, 24, 0, Math.PI * 2);
  ctx.fillStyle = currentAmmo ? currentAmmo.color : '#999';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  if (currentAmmo) {
    ctx.font = `26px ${EMOJI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(currentAmmo.emoji, x, y - 13);
  }

  // 底座
  ctx.fillStyle = '#455a64';
  roundRect(x - 40, y + 44, 80, 12, 6);
  ctx.fill();
}

function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = Math.max(p.life / 0.7, 0);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawFloats() {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const f of floats) {
    ctx.globalAlpha = Math.min(f.life * 1.6, 1);
    ctx.font = `bold 17px sans-serif`;
    ctx.strokeStyle = 'rgba(0,0,0,.4)';
    ctx.lineWidth = 3;
    ctx.strokeText(f.text, f.x, f.y);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- 输入 ----------
function setAim(px, py) {
  const a = Math.atan2(py - CANNON.y, px - CANNON.x);
  if (a > Math.PI / 2) aimAngle = -Math.PI + 0.26;       // 左下 → 贴左
  else if (a > -0.26) aimAngle = -0.26;                  // 右下 → 贴右
  else aimAngle = a;
}

function canvasPos(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return { x: (clientX - r.left) / r.width * W, y: (clientY - r.top) / r.height * H };
}

canvas.addEventListener('mousemove', e => {
  const p = canvasPos(e.clientX, e.clientY);
  setAim(p.x, p.y);
});
canvas.addEventListener('click', e => {
  const p = canvasPos(e.clientX, e.clientY);
  setAim(p.x, p.y);
  shoot();
});
canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  const t = e.touches[0], p = canvasPos(t.clientX, t.clientY);
  setAim(p.x, p.y);
}, { passive: false });
canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  const t = e.touches[0], p = canvasPos(t.clientX, t.clientY);
  setAim(p.x, p.y);
}, { passive: false });
canvas.addEventListener('touchend', e => { e.preventDefault(); shoot(); }, { passive: false });

window.addEventListener('keydown', e => {
  if (e.code === 'Space') { e.preventDefault(); shoot(); }
  keys[e.code.replace('Key', '')] = true;
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') keys[e.code] = true;
});
window.addEventListener('keyup', e => { keys[e.code] = false; });

$('startBtn').addEventListener('click', () => { audio(); startGame(); });
$('restartBtn').addEventListener('click', () => { audio(); startGame(); });

// ---------- 主循环 ----------
let last = performance.now();
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.033);
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

})();
