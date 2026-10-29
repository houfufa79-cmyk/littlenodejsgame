/* ==========================================================================
 * 减肥八法大作战 —— 微信小游戏版
 * 入口文件：game.js（根目录，compileType: "game"）
 * 适配点：
 *   1) canvas:    wx.createCanvas()   全局唯一，逻辑坐标 480×720
 *   2) 触摸:      wx.onTouchStart/Move/End → 逻辑坐标映射
 *   3) 存储:      wx.getStorageSync / wx.setStorageSync('lw_best')
 *   4) UI 全自绘：开始/结束界面、HUD、按钮（hitTest 命中检测）
 *   5) 音效静默：小游戏无 WebAudio，如需可接入 mp3
 * 游戏机制 100% 保留（关卡/分数/溅射/连消/抖动/警戒线闪烁）
 * ========================================================================== */

'use strict';

// ==========================================================================
// 微信小游戏平台 API Shim（JSCore 环境没有这些浏览器 API，必须补齐）
// ==========================================================================

// 1. performance.now() —— 微信小游戏没有 performance 对象
//    用 Date.now() 兜底（毫秒精度足够做 dt 计算）
var _startTs = Date.now();
if (typeof performance === 'undefined') {
  var root = typeof global !== 'undefined' ? global : Function('return this')();
  root.performance = {
    now: function () { return Date.now() - _startTs; },
    timing: {}
  };
} else if (typeof performance.now !== 'function') {
  performance.now = function () { return Date.now() - _startTs; };
}

// 2. requestAnimationFrame / cancelAnimationFrame —— 小游戏有但老版本可能缺失
if (typeof requestAnimationFrame === 'undefined') {
  requestAnimationFrame = function (cb) {
    return setTimeout(function () { cb(Date.now()); }, 1000 / 60);
  };
  cancelAnimationFrame = function (id) { clearTimeout(id); };
}

// 3. setTimeout / clearTimeout —— 理论上小游戏有，但经验里曾报独立错误
if (typeof setTimeout === 'undefined') {
  setTimeout = function (fn, delay) { return wx.setTimeout(fn, delay); };
  clearTimeout = function (id) { wx.clearTimeout(id); };
}
if (typeof setInterval === 'undefined') {
  setInterval = function (fn, delay) { return wx.setInterval(fn, delay); };
  clearInterval = function (id) { wx.clearInterval(id); };
}

// 4. 把 setTimeout/setInterval 挂到 global 上裸标识符可解析（某些 JSCore 版本需要）
if (typeof global !== 'undefined') {
  if (!global.setTimeout)    global.setTimeout    = setTimeout;
  if (!global.clearTimeout)  global.clearTimeout  = clearTimeout;
  if (!global.setInterval)   global.setInterval   = setInterval;
  if (!global.clearInterval) global.clearInterval = clearInterval;
  if (!global.performance)     global.performance     = performance;
  if (!global.requestAnimationFrame)  global.requestAnimationFrame  = requestAnimationFrame;
  if (!global.cancelAnimationFrame)   global.cancelAnimationFrame   = cancelAnimationFrame;
}

// ---------- 常量（与 H5 完全一致） ----------
const W = 480, H = 720;
const CELL_W = 54, CELL_H = 46, LEG_R = 23, COLS = 8, GRID_TOP = 80;
const DANGER_Y = H - 165;
const CANNON = { x: W / 2, y: H - 64 };
const BULLET_R = 19, BULLET_SPEED = 740, COOLDOWN = 0.24;

const SPORTS = [
  { emoji: '🚶', name: '走路',   color: '#43a047' },
  { emoji: '🏊', name: '游泳',   color: '#1e88e5' },
  { emoji: '🪢', name: '跳绳',   color: '#8e24aa' },
  { emoji: '🏓', name: '乒乓球', color: '#f4511e' },
  { emoji: '🏀', name: '篮球',   color: '#fb8c00', splash: true },
  { emoji: '🏸', name: '羽毛球', color: '#00acc1' },
];
const randSport = () => SPORTS[(Math.random() * SPORTS.length) | 0];

// ---------- Canvas ----------
const canvas = wx.createCanvas();
const ctx = canvas.getContext('2d');
let DPR = 2;
let SCALE = 1;        // 窗口等比缩放
let OFFSET_X = 0, OFFSET_Y = 0;  // 居中偏移

function fitCanvas() {
  const sys = wx.getSystemInfoSync();
  DPR = sys.pixelRatio || 2;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  SCALE = Math.min(sys.windowWidth / W, sys.windowHeight / H);
  OFFSET_X = (sys.windowWidth - W * SCALE) / 2;
  OFFSET_Y = (sys.windowHeight - H * SCALE) / 2;
}
fitCanvas();

// ---------- 游戏状态 ----------
let state = 'start';           // start | playing | gameover
let level = 1, score = 0;
let best = +(wx.getStorageSync('lw_best') || 0);
let legs = [], bullets = [], particles = [], floats = [];
let gridOffsetY = 0, descentSpeed = 4;
let currentAmmo, nextAmmo;
let cooldownT = 0, aimAngle = -Math.PI / 2;
let pendingNext = false, nextTimer = 0;
let shake = 0, gameTime = 0;

// Toast
let toastText = '', toastAlpha = 0, toastTimer = 0;
function toast(text) {
  toastText = text; toastAlpha = 1; toastTimer = 1.5;
}

// ---------- 关卡构建 ----------
function buildLevel(lv) {
  legs = []; gridOffsetY = 0;
  const rows = Math.min(3 + lv, 8);
  const p2 = lv < 2 ? 0 : Math.min(0.08 * (lv - 1), 0.35);
  for (let r = 0; r < rows; r++) {
    const n = r % 2 ? COLS - 1 : COLS;
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
function setAim(px, py) {
  const a = Math.atan2(py - CANNON.y, px - CANNON.x);
  if (a > Math.PI / 2) aimAngle = -Math.PI + 0.26;
  else if (a > -0.26) aimAngle = -0.26;
  else aimAngle = a;
}

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
}

function onHit(target, sport) {
  const tp = legPos(target);
  const destroyed = [];
  const damage = leg => { leg.hp--; if (leg.hp <= 0) destroyed.push(leg); };

  damage(target);
  if (sport.splash) {
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
      floats.push({ x: p.x, y: p.y, text: '+' + (l.maxHp === 2 ? 120 : 50), life: 1, color: '#fff' });
    }
    if (destroyed.length >= 2) {
      gain += (destroyed.length - 1) * 30;
      floats.push({ x: tp.x, y: tp.y - 52, text: '🔥 ' + destroyed.length + '连消!', life: 1.2, color: '#ffd54f' });
    }
    score += gain;
    shake = Math.min(9, shake + 3 + destroyed.length);
  } else {
    score += target.hp < target.maxHp ? 20 : 0;
    burst(tp.x, tp.y, '#d7ccc8', 6);
  }
}

function burst(x, y, color, n) {
  n = n || 12;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 160;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, life: 0.6 + Math.random() * 0.3, color });
  }
}

// ---------- 游戏控制 ----------
function startGame() {
  level = 1; score = 0;
  bullets = []; particles = []; floats = [];
  gridOffsetY = 0; descentSpeed = 4;
  cooldownT = 0; aimAngle = -Math.PI / 2;
  pendingNext = false; shake = 0; gameTime = 0;
  toastText = ''; toastAlpha = 0; toastTimer = 0;
  buildLevel(1);
  currentAmmo = randSport(); nextAmmo = randSport();
  state = 'playing';
  toast('第 1 关');
}

function gameOver() {
  state = 'gameover';
  best = Math.max(best, score);
  wx.setStorageSync('lw_best', best);
}

// ---------- Update ----------
function update(dt) {
  gameTime += dt;
  cooldownT = Math.max(0, cooldownT - dt);
  shake = Math.max(0, shake - 26 * dt);

  for (const p of particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 300 * dt; p.life -= dt; }
  particles = particles.filter(p => p.life > 0);
  for (const f of floats) { f.y -= 46 * dt; f.life -= dt; }
  floats = floats.filter(f => f.life > 0);

  // Toast
  if (toastTimer > 0) {
    toastTimer -= dt;
    toastAlpha = toastTimer > 0 ? (toastTimer < 1.2 ? 1 : toastTimer - 1) : 0;
  } else {
    toastAlpha = Math.max(0, toastAlpha - dt * 3);
  }

  if (state !== 'playing') return;

  if (pendingNext) {
    nextTimer -= dt;
    if (nextTimer <= 0) {
      pendingNext = false;
      level++;
      buildLevel(level);
      toast('第 ' + level + ' 关');
    }
    return;
  }

  gridOffsetY += descentSpeed * dt;

  for (const b of bullets) {
    b.x += b.vx * dt; b.y += b.vy * dt;
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

  for (const leg of legs) {
    if (legPos(leg).y + LEG_R > DANGER_Y) return gameOver();
  }

  if (!legs.length) {
    pendingNext = true;
    nextTimer = 1.6;
    const bonus = level * 150;
    score += bonus;
    toast(level === 8 ? '🎉 八法全通！奖励 ' + bonus : '过关！奖励 ' + bonus + ' kcal');
  }
}

// ==========================================================================
//                              Canvas 绘制
// ==========================================================================

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function draw() {
  ctx.save();
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);

  // 背景渐变
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
  drawHUD();
  drawToast();

  ctx.restore();

  // 覆盖层（不跟随抖动）
  if (state === 'start')    drawStartScreen();
  if (state === 'gameover') drawGameOverScreen();
}

function drawDangerLine() {
  let minDist = Infinity;
  for (const leg of legs) minDist = Math.min(minDist, DANGER_Y - (legPos(leg).y + LEG_R));
  const warn = minDist < 90 && state === 'playing';
  ctx.strokeStyle = warn ? 'rgba(229,57,53,' + (0.55 + 0.45 * Math.sin(gameTime * 10)) + ')' : 'rgba(229,57,53,.45)';
  ctx.lineWidth = warn ? 4 : 2;
  ctx.setLineDash([12, 8]);
  ctx.beginPath(); ctx.moveTo(0, DANGER_Y); ctx.lineTo(W, DANGER_Y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = '13px sans-serif';
  ctx.fillStyle = 'rgba(198,40,40,.8)';
  ctx.textAlign = 'left';
  ctx.fillText('⚠️ 警戒线', 8, DANGER_Y - 6);
}

function drawLegs() {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const leg of legs) {
    const p = legPos(leg);
    const rot = Math.sin(gameTime * 2.6 + leg.wob) * 0.12;
    ctx.save();
    ctx.translate(p.x, p.y); ctx.rotate(rot);

    ctx.beginPath(); ctx.arc(0, 0, LEG_R, 0, Math.PI * 2);
    ctx.fillStyle = leg.maxHp === 2 && leg.hp === 2 ? 'rgba(255,213,79,.92)' : 'rgba(255,255,255,.88)';
    ctx.fill();
    ctx.lineWidth = leg.maxHp === 2 ? 3 : 2;
    ctx.strokeStyle = leg.maxHp === 2 ? (leg.hp === 2 ? '#ff8f00' : '#bcaaa4') : 'rgba(0,0,0,.12)';
    ctx.stroke();

    ctx.font = '26px sans-serif';
    ctx.fillText('🍗', 0, 1);

    if (leg.maxHp === 2 && leg.hp === 2) {
      ctx.font = 'bold 10px sans-serif';
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
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function drawBullets() {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const b of bullets) {
    ctx.beginPath(); ctx.arc(b.x, b.y, BULLET_R, 0, Math.PI * 2);
    ctx.fillStyle = b.sport.color; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.stroke();
    ctx.font = '20px sans-serif';
    ctx.fillText(b.sport.emoji, b.x, b.y + 1);
  }
}

function drawCannon() {
  const { x, y } = CANNON;

  // 炮管
  ctx.save();
  ctx.translate(x, y); ctx.rotate(aimAngle + Math.PI / 2);
  ctx.fillStyle = '#546e7a';
  roundRect(ctx, -8, -52, 16, 44, 7); ctx.fill();
  ctx.restore();

  // 塔身
  const grad = ctx.createLinearGradient(x - 30, y, x + 30, y);
  grad.addColorStop(0, '#78909c');
  grad.addColorStop(0.5, '#b0bec5');
  grad.addColorStop(1, '#78909c');
  ctx.fillStyle = grad;
  roundRect(ctx, x - 26, y - 8, 52, 58, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.2)'; ctx.stroke();

  // 当前弹药泡泡
  ctx.beginPath(); ctx.arc(x, y - 14, 24, 0, Math.PI * 2);
  ctx.fillStyle = currentAmmo ? currentAmmo.color : '#999'; ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
  if (currentAmmo) {
    ctx.font = '26px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(currentAmmo.emoji, x, y - 13);
  }

  // 底座
  ctx.fillStyle = '#455a64';
  roundRect(ctx, x - 40, y + 44, 80, 12, 6); ctx.fill();
}

function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = Math.max(p.life / 0.7, 0);
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawFloats() {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const f of floats) {
    ctx.globalAlpha = Math.min(f.life * 1.6, 1);
    ctx.font = 'bold 17px sans-serif';
    ctx.strokeStyle = 'rgba(0,0,0,.4)';
    ctx.lineWidth = 3;
    ctx.strokeText(f.text, f.x, f.y);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;
}

// ---------- HUD ----------
function drawHUD() {
  if (state !== 'playing') return;

  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.font = 'bold 14px sans-serif';

  // 关卡
  drawHudChip(10, 8, '关卡 ' + level, '#ffd54f');
  // 分数
  drawHudChip(120, 8, '🔥 ' + score + ' kcal', '#ffd54f');
  // 剩余
  drawHudChip(280, 8, '🍗 剩 ' + legs.length, '#ffd54f');
  // 下一个弹药
  ctx.fillStyle = 'rgba(0,0,0,.38)';
  roundRect(ctx, W - 130, 8, 120, 30, 15); ctx.fill();
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = '13px sans-serif'; ctx.fillStyle = '#fff';
  ctx.fillText('下一个', W - 120, 23);
  // emoji 圆泡泡
  ctx.beginPath(); ctx.arc(W - 28, 23, 12, 0, Math.PI * 2);
  ctx.fillStyle = '#fff'; ctx.fill();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '16px sans-serif';
  ctx.fillText(nextAmmo ? nextAmmo.emoji : '', W - 28, 23);
}
function drawHudChip(x, y, text, color) {
  ctx.fillStyle = 'rgba(0,0,0,.38)';
  roundRect(ctx, x, y, ctx.measureText(text).width + 20, 30, 15); ctx.fill();
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = '14px sans-serif'; ctx.fillStyle = '#fff';
  ctx.fillText(text, x + 10, y + 15);
}

// ---------- Toast ----------
function drawToast() {
  if (toastAlpha <= 0 || !toastText) return;
  ctx.globalAlpha = Math.min(toastAlpha, 1);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 28px sans-serif';
  ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 6;
  ctx.strokeText(toastText, W / 2, 200);
  ctx.fillStyle = '#ffd54f';
  ctx.fillText(toastText, W / 2, 200);
  ctx.globalAlpha = 1;
}

// ---------- 开始界面 ----------
let startBtnRect = null;
function drawStartScreen() {
  ctx.fillStyle = 'rgba(10,25,35,.85)';
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 40px sans-serif';
  ctx.fillStyle = '#ffd54f';
  ctx.fillText('减肥八法大作战', W / 2, 180);
  ctx.font = '18px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.fillText('运动六法出击 · 消灭鸡腿塔', W / 2, 215);

  // 运动图标列表
  const sports = ['🚶 走路', '🏊 游泳', '🪢 跳绳', '🏓 乒乓球', '🏀 篮球', '🏸 羽毛球'];
  ctx.font = '14px sans-serif';
  sports.forEach((s, i) => {
    const col = i % 2; const row = Math.floor(i / 2);
    const x = W / 2 + (col === 0 ? -100 : 100);
    const y = 270 + row * 28;
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    roundRect(ctx, x - 55, y - 12, 110, 24, 12); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.fillText(s, x, y);
  });

  // Tips
  ctx.font = '14px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.75)';
  ctx.fillText('🎯 手指瞄准 · 松开发射', W / 2, 400);
  ctx.fillText('🏀 篮球带「燃脂爆发」溅射伤害', W / 2, 422);
  ctx.fillText('⚠️ 别让鸡腿塔压到红线！', W / 2, 444);

  // 按钮
  startBtnRect = { x: W / 2 - 90, y: 500, w: 180, h: 56 };
  drawButton(startBtnRect, '开始燃脂', '#ffd54f', '#4e2c00');

  // 历史最佳
  if (best > 0) {
    ctx.font = '14px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.75)';
    ctx.fillText('历史最佳：' + best + ' kcal', W / 2, 600);
  }
}

// ---------- 结束界面 ----------
let restartBtnRect = null;
function drawGameOverScreen() {
  ctx.fillStyle = 'rgba(10,25,35,.85)';
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 38px sans-serif'; ctx.fillStyle = '#ff6b6b';
  ctx.fillText('🍗 鸡腿攻陷了阵地！', W / 2, 220);

  ctx.font = '22px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.fillText('本次燃脂', W / 2 - 80, 290);
  ctx.font = 'bold 36px sans-serif'; ctx.fillStyle = '#ffd54f';
  ctx.fillText(score + ' kcal', W / 2 + 80, 290);

  ctx.font = '18px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.7)';
  ctx.fillText('历史最佳：' + best + ' kcal', W / 2, 340);

  restartBtnRect = { x: W / 2 - 90, y: 400, w: 180, h: 56 };
  drawButton(restartBtnRect, '再战一局', '#ffd54f', '#4e2c00');
}

function drawButton(rect, text, bg, fg) {
  ctx.fillStyle = bg;
  roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 28); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 22px sans-serif'; ctx.fillStyle = fg;
  ctx.fillText(text, rect.x + rect.w / 2, rect.y + rect.h / 2);
}

// ==========================================================================
//                              触摸输入
// ==========================================================================

function toLogic(e) {
  // 微信小游戏的触摸坐标已经是屏幕像素，减去居中偏移再除缩放
  return {
    x: (e.clientX - OFFSET_X) / SCALE,
    y: (e.clientY - OFFSET_Y) / SCALE,
  };
}

function hitTest(rect, p) {
  return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
}

wx.onTouchStart(res => {
  const t = res.touches[0];
  const p = toLogic(t);

  // 覆盖层按钮优先
  if (state === 'start' && startBtnRect && hitTest(startBtnRect, p)) {
    startGame();
    return;
  }
  if (state === 'gameover' && restartBtnRect && hitTest(restartBtnRect, p)) {
    startGame();
    return;
  }

  if (state === 'playing') setAim(p.x, p.y);
});

wx.onTouchMove(res => {
  if (state !== 'playing') return;
  const t = res.touches[0];
  setAim(toLogic(t).x, toLogic(t).y);
});

wx.onTouchEnd(() => {
  if (state === 'playing') shoot();
});

// ==========================================================================
//                              主循环
// ==========================================================================

let _lastT = performance.now();
function loop(now) {
  const dt = Math.min((now - _lastT) / 1000, 0.033);
  _lastT = now;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
