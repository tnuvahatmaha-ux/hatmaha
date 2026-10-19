import { get, post, del } from './api.js';

/**
 * התראות לטלפון (Web Push).
 *
 * באנדרואיד ובמחשב זה עובד מהדפדפן. באייפון (iOS 16.4 ומעלה) רק אחרי
 * "הוספה למסך הבית" — ואז האפליקציה נפתחת כאפליקציה עצמאית, ושם מבקשים הרשאה.
 */

export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

export const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** 'unsupported' | 'needs-install' | 'denied' | 'on' | 'off' */
export async function pushState() {
  if (!pushSupported()) return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

const toUint8 = (base64) => {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('לא ניתנה הרשאה להתראות. אפשר לשנות בהגדרות הדפדפן.');
  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
  await navigator.serviceWorker.ready;
  const { publicKey } = await get('/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toUint8(publicKey) });
  }
  const json = sub.toJSON();
  await post('/api/push/subscribe', { endpoint: json.endpoint, keys: json.keys });
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await del('/api/push/subscribe', { body: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
}

/** אחרי התחברות: מרענן את המנוי בשרת (למקרה שהמכשיר עבר משתמש) */
export async function syncPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const reg = await registerServiceWorker();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const json = sub.toJSON();
  await post('/api/push/subscribe', { endpoint: json.endpoint, keys: json.keys }).catch(() => {});
}
