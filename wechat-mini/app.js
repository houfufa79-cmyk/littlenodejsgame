// app.js — 小程序入口
App({
  onLaunch() {
    // 预加载最高分到全局（后续可用于多页面分享）
    const best = wx.getStorageSync('lw_best') || 0;
    this.globalData = { best };
  },
  globalData: { best: 0 }
});
