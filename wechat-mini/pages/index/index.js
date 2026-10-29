/* ========================================================================
 * 减肥八法大作战 —— 微信小程序版
 * 基于 H5 game.js 移植，保留全部游戏机制（关卡/分数/溅射/连消/抖动等）
 * 适配点：
 *   1) canvas: wx.createSelectorQuery().select('#game').node() 逻辑坐标 480×720
 *   2) 触摸: canvas.bindtouchstart/move/end → this.onTouchStart/Move/End
 *   3) 存储: wx.getStorageSync / wx.setStorageSync
 *   4) DOM:   this.setData 驱动 WXML 覆盖层更新
 *   5) 音频:  小程序 Canvas 无 WebAudio，音效静默（可按需接入 mp3 资源）
 * ====================================================================== */

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

// ---------- Page ----------
Page({
  data: {
    state: 'start',       // start | playing | gameover
    hudLevel: 1,
    hudScore: 0,
    hudLeft: 0,
    nextEmoji: '',
    toastText: '',
    toastShow: false,
    best: 0,
  },

  /* ---------- 生命周期 ---------- */
  onLoad() {
    const best = wx.getStorageSync('lw_best') || 0;
    this.setData({ best });

    // 状态
    this.level = 1;
    this.score = 0;
    this.legs = [];
    this.bullets = [];
    this.particles = [];
    this.floats = [];
    this.gridOffsetY = 0;
    this.descentSpeed = 4;
    this.currentAmmo = null;
    this.nextAmmo = null;
    this.cooldownT = 0;
    this.aimAngle = -Math.PI / 2;
    this.pendingNext = false;
    this.nextTimer = 0;
    this.shake = 0;
    this.time = 0;
    this.toastTimer = null;
    this._rafId = 0;

    this._initCanvas();
  },

  onUnload() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this.toastTimer) clearTimeout(this.toastTimer);
  },

  /* ---------- Canvas 初始化 ---------- */
  _initCanvas() {
    const sys = wx.getSystemInfoSync();
    // 以短边等比缩放到逻辑坐标 480×720
    const scale = Math.min(sys.windowWidth / W, sys.windowHeight / H);
    const cssW = W * scale;
    const cssH = H * scale;
    const left = (sys.windowWidth - cssW) / 2;
    const top = (sys.windowHeight - cssH) / 2;
    this._scale = scale;
    this._offsetX = left;
    this._offsetY = top;

    const query = wx.createSelectorQuery();
    query.select('#game')
      .fields({ node: true, size: true })
      .exec(res => {
        if (!res || !res[0] || !res[0].node) {
          console.error('canvas 节点获取失败');
          return;
        }
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const dpr = sys.pixelRatio || 2;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.imageSmoothingEnabled = true;

        this._canvas = canvas;
        this._ctx = ctx;

        // 调整 wrap 尺寸 & 位置（canvas 是全屏铺满的，我们通过 canvas 坐标处理）
        wx.createSelectorQuery().select('.game-canvas').boundingClientRect().exec();

        this._lastT = performance.now();
        this._loop(this._lastT);
      });
  },

  /* ---------- 输入：触摸 → 逻辑坐标 ---------- */
  _toLogic(e) {
    return {
      x: (e.x - this._offsetX) / this._scale,
      y: (e.y - this._offsetY) / this._scale,
    };
  },

  onTouchStart(e) {
    if (this.data.state !== 'playing') return;
    const t = e.touches[0];
    const p = this._toLogic(t);
    this._setAim(p.x, p.y);
  },
  onTouchMove(e) {
    if (this.data.state !== 'playing') return;
    const t = e.touches[0];
    const p = this._toLogic(t);
    this._setAim(p.x, p.y);
  },
  onTouchEnd(e) {
    if (this.data.state !== 'playing' || this._skipEnd) { this._skipEnd = false; return; }
    this._shoot();
  },

  /* ---------- 主循环 ---------- */
  _loop(now) {
    const dt = Math.min((now - this._lastT) / 1000, 0.033);
    this._lastT = now;
    this._update(dt);
    this._draw();
    this._rafId = requestAnimationFrame((t) => this._loop(t));
  },

  /* ---------- 关卡构建（原 buildLevel） ---------- */
  _buildLevel(lv) {
    this.legs = [];
    this.gridOffsetY = 0;
    const rows = Math.min(3 + lv, 8);
    const p2 = lv < 2 ? 0 : Math.min(0.08 * (lv - 1), 0.35);
    for (let r = 0; r < rows; r++) {
      const n = r % 2 ? COLS - 1 : COLS;
      for (let c = 0; c < n; c++) {
        const hp = Math.random() < p2 ? 2 : 1;
        this.legs.push({ row: r, col: c, hp, maxHp: hp, wob: Math.random() * Math.PI * 2 });
      }
    }
    this.descentSpeed = 3.4 + lv * 0.7;
  },

  _legPos(leg) {
    const stagger = leg.row % 2 ? CELL_W / 2 : 0;
    return {
      x: (W - COLS * CELL_W) / 2 + CELL_W / 2 + leg.col * CELL_W + stagger,
      y: GRID_TOP + leg.row * CELL_H + this.gridOffsetY,
    };
  },

  /* ---------- 射击 ---------- */
  _setAim(px, py) {
    const a = Math.atan2(py - CANNON.y, px - CANNON.x);
    if (a > Math.PI / 2) this.aimAngle = -Math.PI + 0.26;
    else if (a > -0.26) this.aimAngle = -0.26;
    else this.aimAngle = a;
  },

  _shoot() {
    if (this.data.state !== 'playing' || this.pendingNext || this.cooldownT > 0) return;
    this.cooldownT = COOLDOWN;
    this.bullets.push({
      x: CANNON.x + Math.cos(this.aimAngle) * 54,
      y: CANNON.y + Math.sin(this.aimAngle) * 54,
      vx: Math.cos(this.aimAngle) * BULLET_SPEED,
      vy: Math.sin(this.aimAngle) * BULLET_SPEED,
      sport: this.currentAmmo,
    });
    this.currentAmmo = this.nextAmmo;
    this.nextAmmo = randSport();
    this.setData({ nextEmoji: this.nextAmmo.emoji });
    // sfx.shoot();  // 小程序 canvas 无 WebAudio，如需音效请接入 mp3
  },

  _onHit(target, sport) {
    const tp = this._legPos(target);
    const destroyed = [];
    const damage = leg => { leg.hp--; if (leg.hp <= 0) destroyed.push(leg); };

    damage(target);
    if (sport.splash) {
      for (const l of this.legs) {
        if (l === target) continue;
        const p = this._legPos(l);
        if (Math.hypot(p.x - tp.x, p.y - tp.y) < CELL_W * 1.05) damage(l);
      }
      this.floats.push({ x: tp.x, y: tp.y - 30, text: '💥 燃脂爆发!', life: 1, color: '#ffb300' });
    }

    if (destroyed.length) {
      this.legs = this.legs.filter(l => !destroyed.includes(l));
      let gain = 0;
      for (const l of destroyed) {
        const p = this._legPos(l);
        gain += l.maxHp === 2 ? 120 : 50;
        this._burst(p.x, p.y, sport.color);
        this.floats.push({ x: p.x, y: p.y, text: '+' + (l.maxHp === 2 ? 120 : 50), life: 1, color: '#fff' });
      }
      if (destroyed.length >= 2) {
        gain += (destroyed.length - 1) * 30;
        this.floats.push({ x: tp.x, y: tp.y - 52, text: '🔥 ' + destroyed.length + '连消!', life: 1.2, color: '#ffd54f' });
      }
      this.score += gain;
      this.shake = Math.min(9, this.shake + 3 + destroyed.length);
    } else {
      this.score += target.hp < target.maxHp ? 20 : 0;
      this._burst(tp.x, tp.y, '#d7ccc8', 6);
    }
  },

  _burst(x, y, color, n) {
    n = n || 12;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 160;
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, life: 0.6 + Math.random() * 0.3, color });
    }
  },

  /* ---------- Update ---------- */
  _update(dt) {
    this.time += dt;
    this.cooldownT = Math.max(0, this.cooldownT - dt);
    this.shake = Math.max(0, this.shake - 26 * dt);

    for (const p of this.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 300 * dt; p.life -= dt; }
    this.particles = this.particles.filter(p => p.life > 0);
    for (const f of this.floats) { f.y -= 46 * dt; f.life -= dt; }
    this.floats = this.floats.filter(f => f.life > 0);

    if (this.data.state !== 'playing') return;

    if (this.pendingNext) {
      this.nextTimer -= dt;
      if (this.nextTimer <= 0) {
        this.pendingNext = false;
        this.level++;
        this._buildLevel(this.level);
        this.setData({ hudLevel: this.level, hudLeft: this.legs.length });
        this._toast('第 ' + this.level + ' 关');
      }
      return;
    }

    this.gridOffsetY += this.descentSpeed * dt;

    for (const b of this.bullets) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.x < BULLET_R)     { b.x = BULLET_R;     b.vx *= -1; }
      if (b.x > W - BULLET_R) { b.x = W - BULLET_R; b.vx *= -1; }

      for (const leg of this.legs) {
        const p = this._legPos(leg);
        if (Math.hypot(p.x - b.x, p.y - b.y) < BULLET_R + LEG_R - 4) {
          this._onHit(leg, b.sport);
          b.dead = true;
          break;
        }
      }
      if (b.y < -30) b.dead = true;
    }
    this.bullets = this.bullets.filter(b => !b.dead);

    // 失败判定
    for (const leg of this.legs) {
      if (this._legPos(leg).y + LEG_R > DANGER_Y) return this._gameOver();
    }

    // 过关判定
    if (!this.legs.length) {
      this.pendingNext = true;
      this.nextTimer = 1.6;
      const bonus = this.level * 150;
      this.score += bonus;
      this._toast(this.level === 8 ? '🎉 八法全通！奖励 ' + bonus : '过关！奖励 ' + bonus + ' kcal');
    }

    // 每帧同步 HUD
    this.setData({ hudScore: this.score, hudLeft: this.legs.length });
  },

  _gameOver() {
    const best = Math.max(this.data.best, this.score);
    wx.setStorageSync('lw_best', best);
    this.setData({ state: 'gameover', best });
  },

  _toast(text) {
    this.setData({ toastText: text, toastShow: true });
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.setData({ toastShow: false });
      setTimeout(() => this.setData({ toastText: '' }), 400);
    }, 1500);
  },

  /* ---------- Draw ---------- */
  _draw() {
    const ctx = this._ctx;
    if (!ctx) return;

    ctx.save();
    if (this.shake > 0) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    // 背景渐变
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#aee9ff');
    bg.addColorStop(0.6, '#e3f7e8');
    bg.addColorStop(1, '#fff3d6');
    ctx.fillStyle = bg;
    ctx.fillRect(-10, -10, W + 20, H + 20);

    this._drawDangerLine(ctx);
    this._drawLegs(ctx);
    if (this.data.state === 'playing' && !this.pendingNext) this._drawTrajectory(ctx);
    this._drawBullets(ctx);
    this._drawCannon(ctx);
    this._drawParticles(ctx);
    this._drawFloats(ctx);

    ctx.restore();
  },

  _drawDangerLine(ctx) {
    let minDist = Infinity;
    for (const leg of this.legs) minDist = Math.min(minDist, DANGER_Y - (this._legPos(leg).y + LEG_R));
    const warn = minDist < 90 && this.data.state === 'playing';
    ctx.strokeStyle = warn ? 'rgba(229,57,53,' + (0.55 + 0.45 * Math.sin(this.time * 10)) + ')' : 'rgba(229,57,53,.45)';
    ctx.lineWidth = warn ? 4 : 2;
    ctx.setLineDash([12, 8]);
    ctx.beginPath();
    ctx.moveTo(0, DANGER_Y);
    ctx.lineTo(W, DANGER_Y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '13px sans-serif';
    ctx.fillStyle = 'rgba(198,40,40,.8)';
    ctx.textAlign = 'left';
    ctx.fillText('⚠️ 警戒线', 8, DANGER_Y - 6);
  },

  _drawLegs(ctx) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const leg of this.legs) {
      const p = this._legPos(leg);
      const rot = Math.sin(this.time * 2.6 + leg.wob) * 0.12;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(rot);

      ctx.beginPath();
      ctx.arc(0, 0, LEG_R, 0, Math.PI * 2);
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
  },

  _drawTrajectory(ctx) {
    let x = CANNON.x + Math.cos(this.aimAngle) * 54;
    let y = CANNON.y + Math.sin(this.aimAngle) * 54;
    let vx = Math.cos(this.aimAngle), vy = Math.sin(this.aimAngle);
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    for (let i = 0; i < 56; i++) {
      x += vx * 10; y += vy * 10;
      if (x < BULLET_R)     { x = BULLET_R;     vx *= -1; }
      if (x > W - BULLET_R) { x = W - BULLET_R; vx *= -1; }
      if (y < 10) break;
      let near = false;
      for (const leg of this.legs) {
        const p = this._legPos(leg);
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
    ctx.globalAlpha = 1;
  },

  _drawBullets(ctx) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const b of this.bullets) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, BULLET_R, 0, Math.PI * 2);
      ctx.fillStyle = b.sport.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.stroke();
      ctx.font = '20px sans-serif';
      ctx.fillText(b.sport.emoji, b.x, b.y + 1);
    }
  },

  _drawCannon(ctx) {
    const { x, y } = CANNON;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(this.aimAngle + Math.PI / 2);
    ctx.fillStyle = '#546e7a';
    this._roundRect(ctx, -8, -52, 16, 44, 7);
    ctx.fill();
    ctx.restore();

    const grad = ctx.createLinearGradient(x - 30, y, x + 30, y);
    grad.addColorStop(0, '#78909c');
    grad.addColorStop(0.5, '#b0bec5');
    grad.addColorStop(1, '#78909c');
    ctx.fillStyle = grad;
    this._roundRect(ctx, x - 26, y - 8, 52, 58, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.2)';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x, y - 14, 24, 0, Math.PI * 2);
    ctx.fillStyle = this.currentAmmo ? this.currentAmmo.color : '#999';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    if (this.currentAmmo) {
      ctx.font = '26px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.currentAmmo.emoji, x, y - 13);
    }

    ctx.fillStyle = '#455a64';
    this._roundRect(ctx, x - 40, y + 44, 80, 12, 6);
    ctx.fill();
  },

  _drawParticles(ctx) {
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(p.life / 0.7, 0);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },

  _drawFloats(ctx) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of this.floats) {
      ctx.globalAlpha = Math.min(f.life * 1.6, 1);
      ctx.font = 'bold 17px sans-serif';
      ctx.strokeStyle = 'rgba(0,0,0,.4)';
      ctx.lineWidth = 3;
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  },

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  },

  /* ---------- 按钮回调 ---------- */
  onStart() {
    this._skipEnd = true;       // 避免点击按钮触发 touchend 造成多余射击
    if (this._startDebounce) return;
    this._startDebounce = true;
    setTimeout(() => { this._startDebounce = false; }, 200);

    this._resetState();
    this._buildLevel(1);
    this.currentAmmo = randSport();
    this.nextAmmo = randSport();
    this.setData({
      state: 'playing',
      hudLevel: 1,
      hudScore: 0,
      hudLeft: this.legs.length,
      nextEmoji: this.nextAmmo.emoji,
    });
  },

  onRestart() {
    this.onStart();
  },

  _resetState() {
    this.level = 1;
    this.score = 0;
    this.legs = [];
    this.bullets = [];
    this.particles = [];
    this.floats = [];
    this.gridOffsetY = 0;
    this.descentSpeed = 4;
    this.cooldownT = 0;
    this.aimAngle = -Math.PI / 2;
    this.pendingNext = false;
    this.nextTimer = 0;
    this.shake = 0;
    this.time = 0;
    // 注意：不要直接写 this.data.xxx，由调用方 setData 更新 state
  },
});
