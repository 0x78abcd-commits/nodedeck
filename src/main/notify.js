// 通知渠道：Telegram、Server 酱、PushPlus（后两个推到微信）。由 VPS 上的 agent 直接发。
function tgOn(settings) {
  const t = settings?.telegram || {};
  return !!(t.enabled && t.botToken && t.chatId);
}
function wechat(settings) {
  const w = settings?.wechat || {};
  return { serverchan: String(w.serverchan || '').trim(), pushplus: String(w.pushplus || '').trim(),
    ...(w.serverchanApi ? { serverchanApi: w.serverchanApi } : {}), ...(w.pushplusApi ? { pushplusApi: w.pushplusApi } : {}) }; // 后两个仅测试用
}
// 开了哪些渠道（显示用）
function channels(settings) {
  const w = wechat(settings);
  return [tgOn(settings) && 'Telegram', w.serverchan && 'Server 酱', w.pushplus && 'PushPlus'].filter(Boolean);
}
const anyOn = (settings) => channels(settings).length > 0;

// 给 changedetection.io 用的 Apprise 通知地址（多个可以一起填，一行一个）
function appriseUrls(settings) {
  const out = [];
  const t = settings?.telegram || {};
  if (tgOn(settings)) out.push({ label: 'Telegram', url: `tgram://${t.botToken}/${t.chatId}` });
  const w = wechat(settings);
  // Apprise 的 schan:// 走 sctapi.ftqq.com（Turbo 版）；Server 酱³（sctp 开头）的 key 它不认
  if (w.serverchan && !/^sctp\d+t/i.test(w.serverchan)) out.push({ label: 'Server 酱', url: `schan://${w.serverchan}` });
  if (w.pushplus) out.push({ label: 'PushPlus', url: `pushplus://${w.pushplus}` });
  return out;
}

module.exports = { tgOn, wechat, channels, anyOn, appriseUrls };
